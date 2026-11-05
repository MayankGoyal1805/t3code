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
import * as Exit from "effect/Exit";
import * as Predicate from "effect/Predicate";
import * as Scope from "effect/Scope";
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
import { rollbackAntigravityConversation } from "../../provider/acp/AntigravityRollback.ts";
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
    input: Omit<AntigravityAcpRuntimeInput, "spawn" | "childProcessSpawner">,
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
 * agy sends nothing over ACP when a subagent reports back and the parent runs on. Its session
 * log has that follow-up, so while a launched subagent is outstanding the log is read and the
 * follow-up is handed to the adapter as the updates the stream lacks. The launch stays running
 * until then, which keeps the turn open.
 */
function followSubagentWake(
  runtime: AntigravityRuntime,
  scope: Scope.Scope,
  profileDirectory: string,
): AntigravityRuntime {
  const tracker = makeAntigravityWakeTracker();
  const launchInputs = new Map<string, unknown>();
  let deliver: Parameters<AntigravityRuntime["handleSessionUpdate"]>[0] | undefined;
  let following = false;

  const follow = Effect.fn("AntigravityAdapterV2.followSubagentWake")(function* (
    sessionId: string,
  ) {
    while (tracker.pending()) {
      const steps = yield* readAntigravityWakeSteps(profileDirectory, sessionId, tracker.cursor());
      for (const output of tracker.advance(steps)) {
        const launchInput =
          output.type === "completed" ? launchInputs.get(output.toolCallId) : null;
        yield* (deliver?.(wakeNotification(sessionId, output, launchInput)) ?? Effect.void).pipe(
          Effect.ignore,
        );
      }
      if (!tracker.pending()) break;
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
    if (following) return;
    following = true;
    yield* follow(notification.sessionId).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          following = false;
        }),
      ),
      Effect.forkIn(scope),
    );
  });

  return {
    ...runtime,
    handleSessionUpdate: (handler) => {
      deliver = handler;
      return runtime.handleSessionUpdate((notification) =>
        observe(notification).pipe(Effect.andThen(handler(notification))),
      );
    },
  };
}

export function makeAntigravityAcpAdapterFlavor(
  options: AntigravityAdapterV2Options & AntigravityFlavorServices,
): AcpAdapterV2Flavor {
  const { profileDirectory } = options;
  const missingConversation = (sessionId: string) =>
    new EffectAcpErrors.AcpRequestError({
      code: -32002,
      errorMessage: `Antigravity has no conversation ${sessionId}. It was created by an older T3 Code runtime or deleted from agy's history, so it cannot be resumed. Start a new thread.`,
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
      if (input.resumeSessionId !== undefined) {
        yield* requireConversation(input.resumeSessionId);
      }
      const scope = yield* Scope.fork(yield* Effect.scope);
      const runtime = yield* options
        .withProcess(
          Scope.close(scope, Exit.void),
          options.makeRuntime({
            ...input,
            sessionSystemPromptAppend: PULL_REQUEST_LINKING_INSTRUCTIONS,
            additionalDirectories: [options.host.paths.attachmentsDir],
          }),
        )
        .pipe(Effect.provideService(Scope.Scope, scope));
      const followed =
        profileDirectory === undefined
          ? runtime
          : followSubagentWake(runtime, scope, profileDirectory);
      return {
        ...followed,
        loadSession: (sessionId, activation) =>
          requireConversation(sessionId).pipe(
            Effect.andThen(runtime.loadSession(sessionId, activation)),
          ),
        resumeSession: (sessionId, activation) =>
          requireConversation(sessionId).pipe(
            Effect.andThen(runtime.resumeSession(sessionId, activation)),
          ),
        start: () =>
          runtime
            .start()
            .pipe(
              Effect.tap(
                (started) => options.onSessionStarted?.(started, input.cwd) ?? Effect.void,
              ),
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
    return yield* rollbackAntigravityConversation({
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
