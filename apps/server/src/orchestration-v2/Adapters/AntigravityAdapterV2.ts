import {
  ANTIGRAVITY_DEFAULT_MODEL,
  ProviderDriverKind,
  ProviderInstanceId,
  type OrchestrationV2ProviderCapabilities,
  type ProviderSetupError,
} from "@t3tools/contracts";
import type { SelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Clock from "effect/Clock";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Predicate from "effect/Predicate";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type * as EffectAcpSchema from "effect-acp/compat";
import * as EffectAcpErrors from "effect-acp/errors";

import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { PULL_REQUEST_LINKING_INSTRUCTIONS } from "@t3tools/provider-core/server/runtimeInstructions";
import type { AntigravityAuth } from "../../provider/AntigravityAuth.ts";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import {
  antigravityAppendsSystemPrompt,
  antigravityPermissionMode,
  antigravityRuntimeModeForSessionMode,
  applyAntigravityAcpModelSelection,
  buildAntigravityPrompt,
  type AntigravityAcpRuntimeInput,
} from "../../provider/acp/AntigravityAcpSupport.ts";
import {
  ANTIGRAVITY_SUBAGENT_BATCH_TITLE,
  antigravitySubagentLaunches,
  describeAntigravitySubagentLaunches,
} from "../../provider/acp/AntigravityChildWork.ts";
import { ANTIGRAVITY_CONVERSATION_SEGMENTS } from "../../provider/acp/AntigravityChildWork.ts";
import {
  ANTIGRAVITY_WAKE_META,
  isAntigravityBackgroundToolName,
  makeAntigravityBackgroundFollower,
} from "../../provider/acp/AntigravityBackground.ts";
import { tailAntigravityHookEvents } from "../../provider/acp/AntigravityHookEvents.ts";
import { ensureAntigravityHooks } from "../../provider/acp/AntigravityHooks.ts";
import { readAntigravityTranscript } from "../../provider/acp/AntigravityTranscript.ts";
import { rollbackAntigravityConversationOffThread } from "../../provider/acp/AntigravityRollback.ts";
import { watchAntigravityPromptOutcome } from "../../provider/acp/AntigravityTurnOutcome.ts";
import {
  makeAntigravityWakeTracker,
  readAntigravityWakeSteps,
  type AntigravityWakeOutput,
} from "../../provider/acp/AntigravityWake.ts";
import {
  antigravityApprovalOptions,
  antigravitySubagentOutput,
  classifyAntigravitySubagentToolCall,
  extractAntigravityUserInputQuestion,
  isAntigravitySubagentTitle,
  makeAntigravityUserInputResponse,
  normalizeAntigravityToolCall,
} from "../../provider/acp/AntigravityProtocol.ts";
import { isAntigravitySignInRequiredError } from "../../provider/antigravityAuthSupport.ts";
import { antigravityConversationExists } from "../../provider/Drivers/AntigravityHome.ts";
import {
  AcpProviderCapabilitiesV2,
  makeAcpAdapterV2,
  type AcpAdapterV2Flavor,
  type AcpAdapterV2RuntimeInput,
} from "@t3tools/provider-acp/server/adapter";

const ANTIGRAVITY_PROVIDER = ProviderDriverKind.make("antigravity");

const TERMINAL_TURN_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
]);

const AntigravityProviderCapabilitiesV2 = {
  ...AcpProviderCapabilitiesV2,
  sessions: {
    ...AcpProviderCapabilitiesV2.sessions,
    supportsModelSwitchInSession: true,
    supportsRuntimeModeSwitchInSession: true,
  },
  tools: {
    ...AcpProviderCapabilitiesV2.tools,
    supportsMcpTools: true,
  },
  subagents: {
    ...AcpProviderCapabilitiesV2.subagents,
    supportsSubagents: true,
  },
} satisfies OrchestrationV2ProviderCapabilities;

export interface AntigravityAdapterV2Options {
  readonly instanceId: ProviderInstanceId;
  readonly selfInvocation: SelfInvocation;
  readonly makeRuntime: (
    input: Omit<AntigravityAcpRuntimeInput, "spawn" | "childProcessSpawner"> & {
      /** The file agy's `t3-code` hook appends to; set only for conversational runtimes. */
      readonly hookEventsFile?: string;
    },
  ) => Effect.Effect<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    EffectAcpErrors.AcpError | ProviderSetupError,
    Scope.Scope
  >;
  readonly withProcess: AntigravityAuth["withProcess"];
  readonly defaultModel: Effect.Effect<string | undefined>;
  readonly onSessionStarted?: (
    started: AcpSessionRuntime.AcpSessionRuntimeStartResult,
    cwd: string,
  ) => Effect.Effect<void>;
  readonly onSessionEvent?: AcpAdapterV2Flavor["onSessionEvent"];
  readonly nativeLogging?: Parameters<typeof makeAcpAdapterV2>[0]["nativeLogging"];
  readonly continuationRequests?: Parameters<typeof makeAcpAdapterV2>[0]["continuationRequests"];
  /** The running agy version; rollback edits agy's private storage only for versions it was verified against. */
  readonly version?: Effect.Effect<string | undefined>;
  /** The Gemini directory that holds agy's `antigravity-cli` data. Its conversations show turns that ended on an upstream error. */
  readonly profileDirectory?: string;
  /** Follow background commands and timers through agy's hooks; needs `profileDirectory` and a POSIX shell. */
  readonly followBackgroundWork?: boolean;
}

/** Marks the update that carries a subagent's report: agy streams none, so the session log supplies it. */
const ANTIGRAVITY_SUBAGENT_REPORT_META = "t3SubagentReport";

/**
 * Native subagent tools report no child session ids, so children stay read-only.
 * The tool call's `rawInput` carries the launch; NativeChildWorkQuery matches child ids by its text.
 */
const extractAntigravitySubagentUpdate: NonNullable<AcpAdapterV2Flavor["extractSubagentUpdate"]> = (
  toolCall,
) => {
  if (classifyAntigravitySubagentToolCall(toolCall) !== "subagent") {
    return undefined;
  }
  // agy reports a launch as completed at once; only the wake follow-up carries the child's report.
  const meta = toolCall.data.meta;
  const report =
    Predicate.isObject(meta) && typeof meta[ANTIGRAVITY_SUBAGENT_REPORT_META] === "string"
      ? meta[ANTIGRAVITY_SUBAGENT_REPORT_META]
      : undefined;
  const status =
    toolCall.status === "failed"
      ? "failed"
      : toolCall.status === "pending"
        ? "pending"
        : report !== undefined
          ? "completed"
          : "running";
  const launches = antigravitySubagentLaunches(toolCall.data.rawInput);
  const launch = launches === undefined ? undefined : describeAntigravitySubagentLaunches(launches);
  return {
    nativeTaskId: toolCall.toolCallId,
    prompt:
      launch?.prompt ??
      antigravitySubagentOutput(toolCall) ??
      toolCall.detail ??
      toolCall.title ??
      ANTIGRAVITY_SUBAGENT_BATCH_TITLE,
    title: launch?.title ?? ANTIGRAVITY_SUBAGENT_BATCH_TITLE,
    model: launch?.model ?? null,
    status,
    childSessionId: null,
    result:
      status === "failed"
        ? (antigravitySubagentOutput(toolCall) ?? null)
        : status === "completed"
          ? (report ?? null)
          : null,
  };
};

interface AntigravityFlavorServices {
  readonly random: SecureRandom.SecureRandom["Service"];
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly host: ProviderHost.ProviderHost["Service"];
}

type AntigravityRuntime = AcpSessionRuntime.AcpSessionRuntime["Service"];

const WAKE_POLL_INTERVAL = "1 second";
const WAKE_MAX_AGE_MILLIS = 30 * 60 * 1000;

const wakeExpiredNotification = (
  sessionId: string,
  toolCallId: string,
  launchInput: unknown,
): EffectAcpSchema.SessionNotification => ({
  sessionId,
  update: {
    sessionUpdate: "tool_call_update",
    toolCallId,
    title: "Run invoke_subagent",
    kind: "other",
    status: "failed",
    rawInput: launchInput,
    rawOutput: "The subagent did not report back.",
  },
});

const wakeNotification = (
  sessionId: string,
  output: AntigravityWakeOutput,
  launchInput: unknown,
): EffectAcpSchema.SessionNotification => ({
  sessionId,
  update:
    output.type === "text"
      ? { sessionUpdate: "agent_message_chunk", content: { type: "text", text: output.text } }
      : {
          sessionUpdate: "tool_call_update",
          toolCallId: output.toolCallId,
          title: "Run invoke_subagent",
          kind: "other",
          status: "completed",
          rawInput: launchInput,
          _meta: { [ANTIGRAVITY_SUBAGENT_REPORT_META]: output.result },
        },
});

/**
 * agy streams nothing when a subagent reports back; its session log holds the follow-up, which is
 * read while a launch is outstanding. Following ends with the turn (new prompt, cancel), a failed
 * launch, or the age cap, so a late wake never reaches another turn.
 */
function followSubagentWake(
  runtime: AntigravityRuntime,
  scope: Scope.Scope,
  profileDirectory: string,
): AntigravityRuntime {
  const tracker = makeAntigravityWakeTracker();
  const launchInputs = new Map<string, unknown>();
  let deliver: Parameters<AntigravityRuntime["handleSessionUpdate"]>[0] | undefined;
  let following: Fiber.Fiber<void> | undefined;

  const send = (notification: EffectAcpSchema.SessionNotification) =>
    (deliver?.(notification) ?? Effect.void).pipe(Effect.ignore);

  const endTurn = Effect.suspend(() => {
    const fiber = following;
    following = undefined;
    tracker.reset();
    launchInputs.clear();
    return fiber === undefined ? Effect.void : Fiber.interrupt(fiber);
  });

  const follow = Effect.fn("AntigravityAdapterV2.followSubagentWake")(function* (
    sessionId: string,
  ) {
    const startedAt = yield* Clock.currentTimeMillis;
    while (tracker.pending()) {
      const steps = yield* readAntigravityWakeSteps(profileDirectory, sessionId, tracker.cursor());
      for (const output of tracker.advance(steps)) {
        const launchInput =
          output.type === "completed" ? launchInputs.get(output.toolCallId) : null;
        yield* send(wakeNotification(sessionId, output, launchInput));
      }
      if (!tracker.pending()) break;
      if ((yield* Clock.currentTimeMillis) - startedAt >= WAKE_MAX_AGE_MILLIS) {
        for (const toolCallId of tracker.pendingIds()) {
          tracker.drop(toolCallId);
          yield* send(wakeExpiredNotification(sessionId, toolCallId, launchInputs.get(toolCallId)));
        }
        break;
      }
      yield* Effect.sleep(WAKE_POLL_INTERVAL);
    }
  });

  const observe = Effect.fnUntraced(function* (notification: EffectAcpSchema.SessionNotification) {
    const { update } = notification;
    if (update.sessionUpdate === "agent_message_chunk") {
      if (update.content.type === "text" && tracker.pending()) {
        tracker.observeLiveText(update.content.text);
      }
      return;
    }
    if (
      update.sessionUpdate === "tool_call_update" &&
      update.status === "failed" &&
      tracker.tracks(update.toolCallId)
    ) {
      tracker.drop(update.toolCallId);
      launchInputs.delete(update.toolCallId);
      return;
    }
    // A replayed history carries finished launches; only a live launch has a wake to follow.
    if (
      update.sessionUpdate !== "tool_call" ||
      !isAntigravitySubagentTitle(update.title) ||
      (update.status !== "in_progress" && update.status !== "pending")
    ) {
      return;
    }
    tracker.launch(update.toolCallId);
    launchInputs.set(update.toolCallId, update.rawInput);
    if (following !== undefined) return;
    const fiber = yield* follow(notification.sessionId).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (following === fiber) following = undefined;
        }),
      ),
      Effect.forkIn(scope),
    );
    following = fiber;
  });

  return {
    ...runtime,
    handleSessionUpdate: (handler) => {
      deliver = handler;
      return runtime.handleSessionUpdate((notification) =>
        observe(notification).pipe(Effect.andThen(handler(notification))),
      );
    },
    prompt: (payload, options) => endTurn.pipe(Effect.andThen(runtime.prompt(payload, options))),
    cancel: endTurn.pipe(Effect.andThen(runtime.cancel)),
  };
}

/** The transcript can trail the Stop hook by a moment; a few re-reads, never a loop that runs on. */
const TRANSCRIPT_RETRY_DELAY = "500 millis";
const TRANSCRIPT_MAX_READS = 6;
/** A finished task's card waits for its wake's follow-up so one run carries both; a missing Stop must not hold it forever. */
const WAKE_HOLD_CAP = "90 seconds";

/**
 * agy reports nothing when a background command or timer ends, or for the follow-up it then runs.
 * Its `t3-code` hook appends each event to `eventsFile`; this turns them, with the transcript the
 * hooks point at, into the updates the protocol would have carried (see AntigravityBackground).
 */
function followBackgroundWork(
  runtime: AntigravityRuntime,
  scope: Scope.Scope,
  fileSystem: FileSystem.FileSystem,
  eventsFile: string,
): AntigravityRuntime {
  const follower = makeAntigravityBackgroundFollower();
  let deliver: Parameters<AntigravityRuntime["handleSessionUpdate"]>[0] | undefined;
  let rootSessionId: string | undefined;
  let tailing = false;

  const send = (updates: ReadonlyArray<EffectAcpSchema.SessionUpdate>) =>
    Effect.forEach(
      updates,
      (update) =>
        rootSessionId === undefined
          ? Effect.void
          : (deliver?.({ sessionId: rootSessionId, update }) ?? Effect.void).pipe(Effect.ignore),
      { discard: true },
    );

  const followTranscript = Effect.fn("AntigravityAdapterV2.followTranscript")(function* (
    transcriptPath: string,
  ) {
    for (let read = 0; read < TRANSCRIPT_MAX_READS; read++) {
      const steps = yield* readAntigravityTranscript(transcriptPath, 0).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
      );
      const result = follower.transcript(steps);
      yield* send(result.updates);
      if (!result.incomplete) return;
      yield* Effect.sleep(TRANSCRIPT_RETRY_DELAY);
    }
    yield* send(follower.flush());
  });

  const onHook = Effect.fn("AntigravityAdapterV2.followBackgroundHook")(function* (
    event: Parameters<typeof follower.hook>[0],
  ) {
    const step = follower.hook(event);
    yield* send(step.updates);
    if (follower.holding()) {
      yield* Effect.sleep(WAKE_HOLD_CAP).pipe(
        Effect.andThen(Effect.suspend(() => send(follower.flush()))),
        Effect.forkIn(scope),
      );
    }
    if (step.read !== undefined) yield* followTranscript(step.read.transcriptPath);
  });

  const started = <A extends { readonly sessionId: string }, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) =>
    effect.pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          rootSessionId = result.sessionId;
          follower.sessionStarted(result.sessionId);
        }),
      ),
    );

  return {
    ...runtime,
    start: () => started(runtime.start()),
    loadSession: (sessionId, activation) => started(runtime.loadSession(sessionId, activation)),
    resumeSession: (sessionId, activation) => started(runtime.resumeSession(sessionId, activation)),
    handleSessionUpdate: Effect.fn("AntigravityAdapterV2.followBackgroundUpdates")(
      function* (handler) {
        deliver = handler;
        if (!tailing) {
          tailing = true;
          yield* Scope.addFinalizer(
            scope,
            Effect.suspend(() => send(follower.lost())),
          );
          yield* tailAntigravityHookEvents(eventsFile).pipe(
            Stream.runForEach(onHook),
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.forkIn(scope),
          );
        }
        return yield* runtime.handleSessionUpdate((notification) =>
          Effect.suspend(() => {
            const { update } = notification;
            if (notification.sessionId !== rootSessionId) return handler(notification);
            // The next prompt makes agy stream the wake it already reported through its hooks.
            if (follower.isReplay(update)) return Effect.void;
            if (
              (update.sessionUpdate === "tool_call" ||
                update.sessionUpdate === "tool_call_update") &&
              isAntigravityBackgroundToolName(update.name)
            ) {
              follower.toolObserved({
                toolCallId: update.toolCallId,
                name: update.name,
                rawInput: update.rawInput,
                status:
                  update.status === "completed" || update.status === "failed" ? "settled" : "open",
              });
            }
            return handler(notification);
          }),
        );
      },
    ),
    prompt: (payload, options) =>
      Effect.sync(() => follower.promptStarted()).pipe(
        Effect.andThen(runtime.prompt(payload, options)),
        Effect.tap((result) =>
          result.stopReason === "end_turn"
            ? Effect.void
            : send(follower.failUnconfirmed("The command was interrupted.")),
        ),
        Effect.tapError(() => send(follower.failUnconfirmed("The turn failed."))),
        Effect.ensuring(Effect.sync(() => follower.promptReturned())),
      ),
    cancel: Effect.suspend(() => send(follower.abandon())).pipe(Effect.andThen(runtime.cancel)),
  };
}

export function makeAntigravityAcpAdapterFlavor(
  options: AntigravityAdapterV2Options & AntigravityFlavorServices,
): AcpAdapterV2Flavor {
  const { profileDirectory } = options;
  const followsBackgroundWork =
    options.followBackgroundWork === true && profileDirectory !== undefined;
  // Tasks are tracked only once hooks are registered; otherwise nothing would ever end them.
  let backgroundHooksLive = false;
  const missingConversation = (sessionId: string) =>
    new EffectAcpErrors.AcpRequestError({
      code: -32002,
      method: "session/load",
      errorMessage: `Antigravity has no conversation ${sessionId}. It was created by an older T3 Code runtime or deleted from agy's history.`,
    });
  const requireConversation = (sessionId: string) =>
    profileDirectory === undefined
      ? Effect.void
      : antigravityConversationExists(profileDirectory, sessionId).pipe(
          Effect.provideService(FileSystem.FileSystem, options.fileSystem),
          Effect.provideService(Path.Path, options.path),
          // agy answers `session/load` for an unknown id with an empty session.
          Effect.filterOrFail(Boolean, () => missingConversation(sessionId)),
          Effect.asVoid,
        );
  const makeRuntime = Effect.fn("AntigravityAdapterV2.makeRuntime")(
    function* (input: AcpAdapterV2RuntimeInput) {
      const scope = yield* Scope.fork(yield* Effect.scope);
      const hookEventsFile =
        followsBackgroundWork &&
        (yield* ensureAntigravityHooks(profileDirectory).pipe(
          Effect.provideService(FileSystem.FileSystem, options.fileSystem),
          Effect.provideService(Path.Path, options.path),
        ))
          ? yield* options.fileSystem.makeTempDirectoryScoped({ prefix: "t3-agy-hooks-" }).pipe(
              Effect.map((directory) => options.path.join(directory, "events")),
              Effect.tap((file) => options.fileSystem.writeFileString(file, "")),
              Effect.provideService(Scope.Scope, scope),
              Effect.catch((cause) =>
                Effect.logWarning("Could not prepare the Antigravity hook events file.", {
                  cause,
                }).pipe(Effect.as(undefined)),
              ),
            )
          : undefined;
      if (hookEventsFile !== undefined) backgroundHooksLive = true;
      const runtime = yield* options
        .withProcess(
          Scope.close(scope, Exit.void),
          options.makeRuntime({
            ...input,
            sessionSystemPromptAppend: PULL_REQUEST_LINKING_INSTRUCTIONS,
            additionalDirectories: [options.host.paths.attachmentsDir],
            ...(hookEventsFile === undefined ? {} : { hookEventsFile }),
          }),
        )
        .pipe(Effect.provideService(Scope.Scope, scope));
      const background =
        hookEventsFile === undefined
          ? runtime
          : followBackgroundWork(runtime, scope, options.fileSystem, hookEventsFile);
      const followed =
        profileDirectory === undefined
          ? background
          : followSubagentWake(background, scope, profileDirectory);
      return {
        ...followed,
        loadSession: (sessionId, activation) =>
          requireConversation(sessionId).pipe(
            Effect.andThen(background.loadSession(sessionId, activation)),
          ),
        resumeSession: (sessionId, activation) =>
          requireConversation(sessionId).pipe(
            Effect.andThen(background.resumeSession(sessionId, activation)),
          ),
        start: () =>
          (input.resumeSessionId === undefined
            ? Effect.void
            : requireConversation(input.resumeSessionId)
          ).pipe(
            Effect.andThen(background.start()),
            Effect.tap((started) => options.onSessionStarted?.(started, input.cwd) ?? Effect.void),
          ),
      } satisfies typeof runtime;
    },
    Effect.provideService(SecureRandom.SecureRandom, options.random),
    Effect.mapError((cause): EffectAcpErrors.AcpError =>
      cause._tag === "ProviderSetupError"
        ? new EffectAcpErrors.AcpTransportError({ detail: cause.detail, cause })
        : cause,
    ),
  );

  // Rolled-back state is a truncated copy of the native conversation, loaded under a new id.
  const rollbackSession: AcpAdapterV2Flavor["rollbackSession"] = Effect.fn(
    "AntigravityAdapterV2.rollbackSession",
  )(function* ({ target, providerThreadTurns, nativeSessionId }) {
    if (profileDirectory === undefined || target.type !== "provider_turn") return undefined;
    const terminalTurns = providerThreadTurns.filter(
      (turn) => turn.nativeTurnRef !== null && TERMINAL_TURN_STATUSES.has(turn.status),
    );
    return yield* rollbackAntigravityConversationOffThread(options.selfInvocation, {
      conversationsDir: options.path.join(profileDirectory, ...ANTIGRAVITY_CONVERSATION_SEGMENTS),
      sessionId: nativeSessionId,
      keepTurns: terminalTurns.filter((turn) => turn.ordinal <= target.providerTurn.ordinal).length,
      expectedTurns: terminalTurns.length,
      version: options.version === undefined ? undefined : yield* options.version,
    });
  });

  return {
    driver: ANTIGRAVITY_PROVIDER,
    runtimeHarness: "Antigravity",
    capabilities: AntigravityProviderCapabilitiesV2,
    // Agents that advertise HTTP MCP skip the stdio bridge process; others keep stdio.
    mcpOverHttp: true,
    sessionCarriesPullRequestLinking: antigravityAppendsSystemPrompt,
    makeRuntime,
    rollbackSession,
    buildPrompt: ({ text, attachments, resolveAttachmentPath, promptCapabilities }) =>
      buildAntigravityPrompt({
        input: text,
        attachments,
        resolveAttachmentPath,
        promptCapabilities,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, options.fileSystem),
        Effect.provideService(Path.Path, options.path),
      ),
    // Without the session log a launch's report never arrives, so its turn must not wait for one.
    subagentsIdleOnTurnCompletion: true,
    deferFinalizeForBackgroundWork: profileDirectory !== undefined,
    ...(followsBackgroundWork
      ? {
          enablePostSettleContinuation: true,
          wakeNotificationsAreComplete: true,
          // Commands and timers outlive the turn: they pin the session but never hold the run open.
          extractBackgroundTaskId: (toolCall) =>
            backgroundHooksLive && isAntigravityBackgroundToolName(toolCall.data.name)
              ? toolCall.toolCallId
              : undefined,
          isPersistentBackgroundTool: () => true,
          isProviderWakeNotification: (notification) => {
            const meta: unknown =
              "_meta" in notification.update ? notification.update._meta : undefined;
            return Predicate.isObject(meta) && meta[ANTIGRAVITY_WAKE_META] === true;
          },
        }
      : {}),
    ...(options.onSessionEvent === undefined ? {} : { onSessionEvent: options.onSessionEvent }),
    applyModelSelection: Effect.fn("AntigravityAdapterV2.applyModelSelection")(function* ({
      runtime,
      modelSelection,
    }) {
      const defaultModel = yield* options.defaultModel;
      return yield* applyAntigravityAcpModelSelection({
        runtime,
        model:
          modelSelection.model === ANTIGRAVITY_DEFAULT_MODEL ? undefined : modelSelection.model,
        defaultModel,
        mapError: (cause) => cause,
      });
    }),
    sessionModeForPolicy: (policy) => antigravityPermissionMode(policy.runtimeMode),
    runtimeModeForSessionMode: antigravityRuntimeModeForSessionMode,
    approvalOptions: antigravityApprovalOptions,
    extractPermissionQuestion: (request) => {
      const question = extractAntigravityUserInputQuestion(request);
      if (question === undefined) return undefined;
      return {
        question,
        respond: (answers) => makeAntigravityUserInputResponse(request, answers),
      };
    },
    normalizeToolCall: normalizeAntigravityToolCall,
    extractSubagentUpdate: extractAntigravitySubagentUpdate,
    supportsImagePrompts: true,
    supportsCompaction: false,
    requiresSignIn: isAntigravitySignInRequiredError,
    // Antigravity can leave a prompt open without updates; long tools and approvals pause this.
    promptInactivityTimeout: "15 minutes",
    reportsPerTurnPromptUsage: true,
    geminiPromptUsage: true,
    ...(profileDirectory === undefined
      ? {}
      : {
          watchPromptOutcome: (sessionId: string) =>
            watchAntigravityPromptOutcome(profileDirectory, sessionId),
        }),
  };
}

export const makeAntigravityAdapterV2 = Effect.fn("makeAntigravityAdapterV2")(function* (
  options: AntigravityAdapterV2Options,
) {
  const services: AntigravityFlavorServices = {
    random: yield* SecureRandom.SecureRandom,
    fileSystem: yield* FileSystem.FileSystem,
    path: yield* Path.Path,
    host: yield* ProviderHost.ProviderHost,
  };
  return yield* makeAcpAdapterV2({
    instanceId: options.instanceId,
    flavor: makeAntigravityAcpAdapterFlavor({ ...options, ...services }),
    selfInvocation: options.selfInvocation,
    ...(options.nativeLogging === undefined ? {} : { nativeLogging: options.nativeLogging }),
    ...(options.continuationRequests === undefined
      ? {}
      : { continuationRequests: options.continuationRequests }),
  });
});
