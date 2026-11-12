import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import { htmlRenderFromToolItem } from "@t3tools/shared/toolOutput";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { ChildProcessSpawner } from "effect/process";
import type * as EffectAcpSchema from "effect-acp/compat";
import * as EffectAcpErrors from "effect-acp/errors";

import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import type * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import {
  CALL_ID,
  CHILD,
  LAUNCH,
  ROOT,
  appendSteps,
  invokeStep,
  plannerStep,
  wakeMessageStep,
  writeConversation,
} from "../../provider/acp/AntigravityChildWork.testkit.ts";
import { ANTIGRAVITY_CONVERSATION_SEGMENTS } from "../../provider/acp/AntigravityChildWork.ts";
import { makeAntigravityAcpRuntime } from "../../provider/acp/AntigravityAcpSupport.ts";
import { normalizeAntigravitySessionUpdate } from "../../provider/acp/AntigravityProtocol.ts";
import { ANTIGRAVITY_SIGN_IN_REQUIRED_MESSAGE } from "../../provider/antigravityAuthSupport.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import {
  makeAntigravityAcpAdapterFlavor,
  makeAntigravityAdapterV2,
} from "./AntigravityAdapterV2.ts";

const flavor = makeAntigravityAcpAdapterFlavor({
  instanceId: ProviderInstanceId.make("antigravity-test"),
  random: undefined as never,
  fileSystem: undefined as never,
  path: undefined as never,
  host: undefined as never,
  selfInvocation: undefined as never,
  makeRuntime: () => Effect.die("not spawned in this test"),
  withProcess: (_stop, task) => task,
  defaultModel: Effect.undefined,
});

function permissionRequest(
  toolCallId: string,
  options: ReadonlyArray<EffectAcpSchema.PermissionOption>,
): EffectAcpSchema.RequestPermissionRequest {
  return {
    sessionId: "session-1",
    options,
    toolCall: { toolCallId, title: "Which branch?" },
  };
}

describe("AntigravityAdapterV2 flavor", () => {
  it("keeps a successful subagent launch running until the parent turn becomes idle", () => {
    const batch = flavor.extractSubagentUpdate?.({
      toolCallId: "trajectory:4",
      title: "Running start_subagent",
      kind: "other",
      status: "completed",
      data: { rawOutput: "Started two agents." },
    });
    assert.equal(batch?.status, "running");
    assert.equal(batch?.prompt, "Started two agents.");
    assert.isNull(batch?.result);
    assert.isTrue(flavor.subagentsIdleOnTurnCompletion);

    // Permission prompts carry the launch; later updates for the same call do not.
    const launch = flavor.extractSubagentUpdate?.({
      toolCallId: "35bea692fa95447fbdae6333fec5515f",
      title: "Run invoke_subagent",
      kind: "other",
      status: "pending",
      data: {
        rawInput: {
          TypeName: "self",
          Role: "Readme Reader",
          Prompt: "Read README.md",
          Model: "flash_lite",
        },
      },
    });
    assert.equal(launch?.title, "Readme Reader");
    assert.equal(launch?.model, "Gemini Flash Lite");
    assert.equal(launch?.prompt, "Read README.md");
  });

  it("routes interaction_* permission requests to the question card", () => {
    const question = flavor.extractPermissionQuestion?.(
      permissionRequest("interaction_1", [
        { optionId: "main", name: "main", kind: "allow_once" },
        { optionId: "dev", name: "dev", kind: "allow_once" },
      ]),
    );
    assert.isDefined(question);
    assert.deepEqual(
      question?.question.options.map((option) => option.label),
      ["main", "dev"],
    );
    assert.deepEqual(question?.respond({ interaction_1: "dev" }), {
      outcome: { outcome: "selected", optionId: "dev" },
    });
    assert.isUndefined(question?.respond({ interaction_1: "nope" }));
    assert.isUndefined(
      flavor.extractPermissionQuestion?.(
        permissionRequest("tool_1", [{ optionId: "allow", name: "Allow", kind: "allow_once" }]),
      ),
    );
  });

  it("keeps the question card to the agent's own options so a typed answer cannot be sent", () => {
    const question = flavor.extractPermissionQuestion?.(
      permissionRequest("interaction_2", [
        { optionId: "opt-main", name: "main", kind: "allow_once" },
        { optionId: "opt-dev", name: "dev", kind: "allow_once" },
      ]),
    );
    assert.strictEqual(question?.question.allowCustomAnswer, false);
    assert.deepEqual(
      question?.question.options.map((option) => option.value),
      ["opt-main", "opt-dev"],
    );
    assert.deepEqual(question?.respond({ interaction_2: "opt-dev" }), {
      outcome: { outcome: "selected", optionId: "opt-dev" },
    });
  });
});

const layerSession = Layer.mergeAll(
  NodeServices.layer,
  NodeCrypto.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  TestProviderHost.layer().pipe(
    Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  ),
);

describe("AntigravityAdapterV2 compaction", () => {
  it.effect("does not expose unsupported manual compaction on the provider session", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const crypto = yield* SecureRandom.SecureRandom;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const instanceId = ProviderInstanceId.make("antigravity-compaction-test");
      const adapter = yield* makeAntigravityAdapterV2({
        instanceId,
        selfInvocation: yield* resolveSelfInvocation(),
        makeRuntime: (input) =>
          makeAntigravityAcpRuntime({
            ...input,
            childProcessSpawner,
            spawn: {
              command: process.execPath,
              args: [mockAgentPath],
              cwd: input.cwd,
              env: { T3_ACP_ANTIGRAVITY: "1" },
            },
          }).pipe(Effect.provideService(SecureRandom.SecureRandom, crypto)),
        withProcess: (_stop, task) => task,
        defaultModel: Effect.undefined,
      });
      const session = yield* adapter.openSession({
        threadId: ThreadId.make("thread-antigravity-compaction"),
        providerSessionId: ProviderSessionId.make("provider-session-antigravity-compaction"),
        modelSelection: { instanceId, model: "gemini-test-low" },
        runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
        }),
      });
      assert.isUndefined(session.compactThread);
    }).pipe(Effect.provide(layerSession), Effect.scoped),
  );
});

describe("AntigravityAdapterV2 session open", () => {
  it.effect.each([
    {
      name: "browser sign-in",
      cause: new EffectAcpErrors.AcpTransportError({
        detail: ANTIGRAVITY_SIGN_IN_REQUIRED_MESSAGE,
        cause: undefined,
      }),
      requiresSignIn: true,
    },
    {
      name: "ACP authentication required",
      cause: EffectAcpErrors.AcpRequestError.authRequired(),
      requiresSignIn: true,
    },
    {
      name: "transport failure",
      cause: new EffectAcpErrors.AcpTransportError({
        detail: "Connection closed",
        cause: undefined,
      }),
      requiresSignIn: undefined,
    },
  ] as const)("classifies $name during session open", ({ cause, requiresSignIn }) =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("antigravity-sign-in-test");
      const adapter = yield* makeAntigravityAdapterV2({
        instanceId,
        selfInvocation: yield* resolveSelfInvocation(),
        makeRuntime: () => Effect.fail(cause),
        withProcess: (_stop, task) => task,
        defaultModel: Effect.undefined,
      });
      const threadId = ThreadId.make("thread-antigravity-sign-in");
      const error = yield* adapter
        .openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-antigravity-sign-in"),
          modelSelection: { instanceId, model: "gemini-test-low" },
          runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: process.cwd(),
          }),
        })
        .pipe(Effect.flip);

      assert.equal(error._tag, "ProviderAdapterOpenSessionError");
      assert.equal(
        error._tag === "ProviderAdapterOpenSessionError" && error.requiresSignIn,
        requiresSignIn,
      );
    }).pipe(Effect.provide(layerSession), Effect.scoped),
  );
});

describe("AntigravityAdapterV2 html_render pages", () => {
  it.effect("shows the page html_render published when the agent reports only a summary", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const crypto = yield* SecureRandom.SecureRandom;
      const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
      let sessionUpdate: Parameters<RuntimeService["handleSessionUpdate"]>[0] | undefined;
      const instanceId = ProviderInstanceId.make("antigravity-html-render-test");
      const threadId = ThreadId.make("thread-antigravity-html-render");
      const page = (name: string) => ({
        attachmentId: `${threadId}-${name}-html`,
        title: "Revenue",
        height: 240,
      });
      // Long enough that Antigravity bounds the html the adapter sees.
      const rows = Array.from({ length: 500 }, (_, row) => `<tr><td>Row ${row}</td></tr>`);
      const report = { html: `<table>${rows.join("")}</table>`, title: "Revenue", height: 240 };
      const failed = { ...report, html: "<p>Revenue</p>" };
      const errored = { ...report, html: "<p>Revenue error</p>" };
      const adapter = yield* makeAntigravityAdapterV2({
        instanceId,
        selfInvocation: yield* resolveSelfInvocation(),
        makeRuntime: (input) =>
          makeAntigravityAcpRuntime({
            ...input,
            childProcessSpawner,
            spawn: {
              command: process.execPath,
              args: [mockAgentPath],
              cwd: input.cwd,
              env: { T3_ACP_ANTIGRAVITY: "1" },
            },
          }).pipe(
            Effect.provideService(SecureRandom.SecureRandom, crypto),
            Effect.map((runtime): RuntimeService => ({
              ...runtime,
              handleSessionUpdate: (handler) =>
                Effect.sync(() => {
                  sessionUpdate = handler;
                }).pipe(Effect.andThen(runtime.handleSessionUpdate(handler))),
              // agy_acp_server 1.3/1.4 without a permission prompt: the call is
              // titled "Running <tool>" and completes with the step's summary
              // in place of the MCP result.
              prompt: () =>
                Effect.gen(function* () {
                  const send = (update: EffectAcpSchema.SessionUpdate) =>
                    sessionUpdate === undefined
                      ? Effect.die("the adapter must handle session updates")
                      : sessionUpdate(
                          normalizeAntigravitySessionUpdate({
                            sessionId: "mock-session-1",
                            update,
                          }),
                        );
                  const calls = [
                    ["published", report],
                    ["unpublished", { ...report, html: "<p>Costs</p>" }],
                    ["failed", failed],
                    ["error", errored],
                  ] as const;
                  for (const [toolCallId, rawInput] of calls) {
                    yield* send({
                      sessionUpdate: "tool_call",
                      toolCallId,
                      title: "Running html_render",
                      kind: "other",
                      status: "in_progress",
                      rawInput,
                    });
                  }
                  yield* mcpSessions.recordHtmlRender(threadId, report, page("report"));
                  yield* mcpSessions.recordHtmlRender(threadId, failed, page("failed"));
                  yield* mcpSessions.recordHtmlRender(threadId, errored, page("error"));
                  for (const [toolCallId, status] of [
                    ["unpublished", "completed"],
                    ["failed", "failed"],
                    ["published", "completed"],
                    ["published", "completed"],
                  ] as const) {
                    yield* send({
                      sessionUpdate: "tool_call_update",
                      toolCallId,
                      status,
                      rawOutput: `Summary of ${toolCallId}`,
                    });
                  }
                  yield* send({
                    sessionUpdate: "tool_call_update",
                    toolCallId: "error",
                    status: "completed",
                    rawOutput: { result: { isError: true, content: [] } },
                  });
                  for (const [name, rawInput] of [
                    ["failed", failed],
                    ["error", errored],
                  ] as const) {
                    const toolCallId = `${name}-retry`;
                    yield* send({
                      sessionUpdate: "tool_call",
                      toolCallId,
                      title: "Running html_render",
                      kind: "other",
                      status: "in_progress",
                      rawInput,
                    });
                    yield* mcpSessions.recordHtmlRender(threadId, rawInput, page(toolCallId));
                    yield* send({
                      sessionUpdate: "tool_call_update",
                      toolCallId: name,
                      status: name === "failed" ? "failed" : "completed",
                      rawOutput:
                        name === "failed"
                          ? "Summary of failed"
                          : { result: { isError: true, content: [] } },
                    });
                    yield* send({
                      sessionUpdate: "tool_call_update",
                      toolCallId,
                      status: "completed",
                      rawOutput: `Summary of ${toolCallId}`,
                    });
                  }
                  yield* mcpSessions.recordHtmlRender(threadId, report, page("replacement"));
                  yield* send({
                    sessionUpdate: "tool_call_update",
                    toolCallId: "published",
                    status: "completed",
                    rawOutput: { htmlRender: page("replacement") },
                  });
                  yield* send({
                    sessionUpdate: "tool_call_update",
                    toolCallId: "published",
                    status: "completed",
                    rawOutput: "Summary of published",
                  });
                  return { stopReason: "end_turn" as const };
                }),
            })),
          ),
        withProcess: (_stop, task) => task,
        defaultModel: Effect.undefined,
      });
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "gemini-test-low" } as const;
      const session = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-antigravity-html-render"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* session.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      yield* session.startTurn({
        appThread: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId: ProjectId.make("project-antigravity-html-render"),
          title: "Antigravity html_render",
          providerInstanceId: instanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: process.cwd(),
          activeProviderThreadId: providerThread.id,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
        threadId,
        runId: RunId.make("run-antigravity-html-render"),
        runOrdinal: 1,
        providerTurnOrdinal: 1,
        attemptId: RunAttemptId.make("attempt-antigravity-html-render"),
        rootNodeId: NodeId.make("node-antigravity-html-render"),
        providerThread,
        message: {
          createdBy: "user",
          creationSource: "web",
          messageId: MessageId.make("message-antigravity-html-render"),
          text: "chart the revenue",
          attachments: [],
        },
        modelSelection,
        runtimePolicy,
      });
      const events = Array.from(
        yield* session.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        ),
      );
      const tool = (nativeId: string) => {
        const event = events.findLast(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.nativeItemRef?.nativeId === nativeId,
        );
        if (event?.type !== "turn_item.updated" || event.turnItem.type !== "dynamic_tool") {
          return undefined;
        }
        const item = event.turnItem;
        return {
          status: item.status,
          toolName: item.toolName,
          page: htmlRenderFromToolItem(item),
          output: item.output,
        };
      };

      assert.deepEqual(tool("published"), {
        status: "completed",
        toolName: "t3-code.html_render",
        page: page("replacement"),
        output: { htmlRender: page("replacement") },
      });
      assert.deepEqual(tool("unpublished"), {
        status: "completed",
        toolName: "t3-code.html_render",
        page: undefined,
        output: "Summary of unpublished",
      });
      assert.deepEqual(tool("failed"), {
        status: "failed",
        toolName: "t3-code.html_render",
        page: undefined,
        output: "Summary of failed",
      });
      assert.deepEqual(tool("error"), {
        status: "completed",
        toolName: "t3-code.html_render",
        page: undefined,
        output: [],
      });
      assert.deepEqual(
        events.flatMap((event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "dynamic_tool" &&
          event.turnItem.nativeItemRef?.nativeId === "published" &&
          event.turnItem.status === "completed"
            ? [htmlRenderFromToolItem(event.turnItem)]
            : [],
        ),
        [page("report"), page("report"), page("replacement"), page("replacement")],
      );
      for (const name of ["failed-retry", "error-retry"]) {
        assert.deepEqual(tool(name), {
          status: "completed",
          toolName: "t3-code.html_render",
          page: page(name),
          output: { htmlRender: page(name) },
        });
      }
      assert.strictEqual(yield* mcpSessions.takeHtmlRender(threadId, report), undefined);
      assert.strictEqual(yield* mcpSessions.takeHtmlRender(threadId, failed), undefined);
      assert.strictEqual(yield* mcpSessions.takeHtmlRender(threadId, errored), undefined);
    }).pipe(Effect.provide(layerSession), Effect.scoped),
  );
});

describe("AntigravityAdapterV2 subagent wake", () => {
  // agy 1.5.1 sends nothing over ACP after the launch turn's end_turn; the follow-up is only in its log.
  const launchInput = {
    Model: LAUNCH.model,
    Prompt: LAUNCH.prompt,
    Role: LAUNCH.role,
    TypeName: "research",
  };
  const launchFrame = {
    toolCallId: CALL_ID,
    title: "Run invoke_subagent",
    kind: "other",
    rawInput: launchInput,
  } as const;

  // The mock agent is a subprocess, and the adapter finalizes after a wall-clock debounce.
  it.live("keeps the turn open for the parent's follow-up and completes the subagent with it", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const crypto = yield* SecureRandom.SecureRandom;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
      const profileDirectory = yield* fileSystem.makeTempDirectoryScoped();
      const conversations = path.join(profileDirectory, ...ANTIGRAVITY_CONVERSATION_SEGMENTS);
      yield* fileSystem.makeDirectory(conversations, { recursive: true });
      const answer = "README.md has 1 line.";
      writeConversation(path.join(conversations, "mock-session-1.db"), [
        { type: 14, payload: new Uint8Array(), metadata: new Uint8Array() },
        plannerStep({ calls: [{ id: CALL_ID, name: "invoke_subagent", args: "{}" }] }),
        invokeStep({ callId: CALL_ID, launches: [LAUNCH], children: [CHILD] }),
        plannerStep({ text: "I have launched a subagent." }),
        wakeMessageStep(CHILD, answer),
        plannerStep({ text: answer }),
      ]);
      let sessionUpdate: Parameters<RuntimeService["handleSessionUpdate"]>[0] | undefined;
      const instanceId = ProviderInstanceId.make("antigravity-wake-test");
      const threadId = ThreadId.make("thread-antigravity-wake");
      const adapter = yield* makeAntigravityAdapterV2({
        instanceId,
        selfInvocation: yield* resolveSelfInvocation(),
        profileDirectory,
        makeRuntime: (input) =>
          makeAntigravityAcpRuntime({
            ...input,
            childProcessSpawner,
            spawn: {
              command: process.execPath,
              args: [mockAgentPath],
              cwd: input.cwd,
              env: { T3_ACP_ANTIGRAVITY: "1" },
            },
          }).pipe(
            Effect.provideService(SecureRandom.SecureRandom, crypto),
            Effect.map((runtime): RuntimeService => ({
              ...runtime,
              handleSessionUpdate: (handler) =>
                Effect.sync(() => {
                  sessionUpdate = handler;
                }).pipe(Effect.andThen(runtime.handleSessionUpdate(handler))),
              prompt: () =>
                Effect.gen(function* () {
                  const send = (update: EffectAcpSchema.SessionUpdate) =>
                    sessionUpdate === undefined
                      ? Effect.die("the adapter must handle session updates")
                      : sessionUpdate({ sessionId: "mock-session-1", update });
                  yield* send({
                    sessionUpdate: "tool_call",
                    ...launchFrame,
                    status: "in_progress",
                  });
                  yield* send({
                    sessionUpdate: "tool_call_update",
                    ...launchFrame,
                    status: "completed",
                  });
                  yield* send({
                    sessionUpdate: "agent_message_chunk",
                    content: { type: "text", text: "I have launched a subagent." },
                  });
                  return { stopReason: "end_turn" as const };
                }),
            })),
          ),
        withProcess: (_stop, task) => task,
        defaultModel: Effect.undefined,
      });
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "gemini-test-low" } as const;
      const session = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-antigravity-wake"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* session.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      yield* session.startTurn({
        appThread: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId: ProjectId.make("project-antigravity-wake"),
          title: "Antigravity wake",
          providerInstanceId: instanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: process.cwd(),
          activeProviderThreadId: providerThread.id,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
        threadId,
        runId: RunId.make("run-antigravity-wake"),
        runOrdinal: 1,
        providerTurnOrdinal: 1,
        attemptId: RunAttemptId.make("attempt-antigravity-wake"),
        rootNodeId: NodeId.make("node-antigravity-wake"),
        providerThread,
        message: {
          createdBy: "user",
          creationSource: "web",
          messageId: MessageId.make("message-antigravity-wake"),
          text: "count the lines in README.md with a subagent",
          attachments: [],
        },
        modelSelection,
        runtimePolicy,
      });
      const events = Array.from(
        yield* session.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        ),
      );

      const terminalIndex = events.findIndex((event) => event.type === "turn.terminal");
      const lastSubagent = events.findLast((event) => event.type === "subagent.updated");
      assert.equal(
        lastSubagent?.type === "subagent.updated" && lastSubagent.subagent.status,
        "completed",
      );
      assert.equal(
        lastSubagent?.type === "subagent.updated" && lastSubagent.subagent.result,
        answer,
      );
      assert.isBelow(events.indexOf(lastSubagent!), terminalIndex);
      const messageText = events.findLast(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "assistant_message" &&
          event.turnItem.text.includes(answer),
      );
      assert.isDefined(messageText);
      assert.isBelow(events.indexOf(messageText!), terminalIndex);
      const terminal = events[terminalIndex];
      assert.equal(terminal?.type === "turn.terminal" && terminal.status, "completed");
    }).pipe(Effect.provide(layerSession), Effect.scoped),
  );
});

describe("AntigravityAdapterV2 background work", () => {
  const SESSION = "mock-session-1";
  const COMMAND = { CommandLine: "sleep 15 && echo ONE", IsDaemon: false, WaitMsBeforeAsync: 500 };
  const commandFrame = {
    toolCallId: "call_1",
    name: "run_command",
    title: COMMAND.CommandLine,
    kind: "execute",
    rawInput: COMMAND,
  } as const;
  const hookLine = (name: string, fields: object) =>
    `${name}\t${JSON.stringify({ conversationId: SESSION, ...fields })}\n`;
  const jsonl = (steps: ReadonlyArray<object>) =>
    steps.map((step) => JSON.stringify(step)).join("\n") + "\n";

  // The mock agent is a subprocess and agy's hook events arrive through a real file watch.
  it.live(
    "keeps a background command running past its turn and delivers its follow-up as a continuation",
    () =>
      Effect.gen(function* () {
        const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const crypto = yield* SecureRandom.SecureRandom;
        const mockAgentPath = yield* path.fromFileUrl(
          new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
        );
        type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
        const profileDirectory = yield* fileSystem.makeTempDirectoryScoped();
        const transcriptPath = path.join(profileDirectory, "transcript_full.jsonl");
        let eventsFile: string | undefined;
        let sessionUpdate: Parameters<RuntimeService["handleSessionUpdate"]>[0] | undefined;
        const offered = yield* Deferred.make<void>();
        const continuationRequests: Array<ProviderContinuationRequests.ProviderContinuationRequest> =
          [];
        const instanceId = ProviderInstanceId.make("antigravity-background-test");
        const threadId = ThreadId.make("thread-antigravity-background");
        // The follower reads the transcript only once agy's Stop hook says the wake ended.
        const transcriptRead = yield* Deferred.make<void>();
        const watchedFileSystem: FileSystem.FileSystem = {
          ...fileSystem,
          stat: (target) =>
            (target === transcriptPath
              ? Deferred.succeed(transcriptRead, undefined)
              : Effect.void
            ).pipe(Effect.andThen(fileSystem.stat(target))),
        };
        const adapter = yield* makeAntigravityAdapterV2({
          instanceId,
          selfInvocation: yield* resolveSelfInvocation(),
          profileDirectory,
          followBackgroundWork: true,
          continuationRequests: {
            offer: (request) =>
              Effect.sync(() => {
                continuationRequests.push(request);
                Deferred.doneUnsafe(offered, Effect.void);
              }),
          },
          makeRuntime: (input) => {
            eventsFile = input.hookEventsFile;
            return makeAntigravityAcpRuntime({
              ...input,
              childProcessSpawner,
              spawn: {
                command: process.execPath,
                args: [mockAgentPath],
                cwd: input.cwd,
                env: { T3_ACP_ANTIGRAVITY: "1" },
              },
            }).pipe(
              Effect.provideService(SecureRandom.SecureRandom, crypto),
              Effect.map((runtime): RuntimeService => ({
                ...runtime,
                handleSessionUpdate: (handler) =>
                  Effect.sync(() => {
                    sessionUpdate = handler;
                  }).pipe(Effect.andThen(runtime.handleSessionUpdate(handler))),
                prompt: () =>
                  Effect.gen(function* () {
                    const send = (update: EffectAcpSchema.SessionUpdate) =>
                      sessionUpdate === undefined
                        ? Effect.die("the adapter must handle session updates")
                        : sessionUpdate({ sessionId: SESSION, update });
                    yield* send({
                      sessionUpdate: "tool_call",
                      ...commandFrame,
                      status: "in_progress",
                    });
                    yield* send({
                      sessionUpdate: "agent_message_chunk",
                      content: { type: "text", text: "started" },
                    });
                    return { stopReason: "end_turn" as const };
                  }),
              })),
            );
          },
          withProcess: (_stop, task) => task,
          defaultModel: Effect.undefined,
        }).pipe(Effect.provideService(FileSystem.FileSystem, watchedFileSystem));
        const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
        });
        const modelSelection = { instanceId, model: "gemini-test-low" } as const;
        const session = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-antigravity-background"),
          modelSelection,
          runtimePolicy,
        });
        const providerThread = yield* session.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        const now = yield* DateTime.now;
        const startTurn = (
          ordinal: number,
          message: {
            createdBy: "user" | "agent";
            creationSource: "web" | "provider";
            text: string;
          },
        ) =>
          session.startTurn({
            appThread: {
              createdBy: "user",
              creationSource: "web",
              id: threadId,
              projectId: ProjectId.make("project-antigravity-background"),
              title: "Antigravity background",
              providerInstanceId: instanceId,
              modelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: process.cwd(),
              activeProviderThreadId: providerThread.id,
              lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
              archivedAt: null,
              settledOverride: null,
              settledAt: null,
              lastVisitedAt: null,
              deletedAt: null,
            },
            threadId,
            runId: RunId.make(`run-antigravity-background-${ordinal}`),
            runOrdinal: ordinal,
            providerTurnOrdinal: ordinal,
            attemptId: RunAttemptId.make(`attempt-antigravity-background-${ordinal}`),
            rootNodeId: NodeId.make(`node-antigravity-background-${ordinal}`),
            providerThread,
            message: {
              ...message,
              messageId: MessageId.make(`message-antigravity-background-${ordinal}`),
              attachments: [],
            },
            modelSelection,
            runtimePolicy,
          });
        const collectTurn = session.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
          Effect.map((events) => Array.from(events)),
        );

        yield* startTurn(1, {
          createdBy: "user",
          creationSource: "web",
          text: "run a long command",
        });
        const first = yield* collectTurn;
        const firstTerminal = first.findLast((event) => event.type === "turn.terminal");
        assert.equal(firstTerminal?.type === "turn.terminal" && firstTerminal.status, "completed");
        const commandItems = first.flatMap((event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "command_execution"
            ? [event.turnItem.status]
            : [],
        );
        assert.equal(commandItems.at(-1), "running");
        assert.isTrue(yield* session.hasPendingBackgroundWork!);
        assert.isDefined(eventsFile);

        // agy's model is still answering when the Stop hook lands: the transcript has the wake
        // message but not yet the follow-up, as in the live run where the first run closed early.
        const beforeAnswer = [
          { step_index: 4, type: "PLANNER_RESPONSE", status: "DONE", content: "started" },
          {
            step_index: 5,
            type: "SYSTEM_MESSAGE",
            status: "DONE",
            content: `<SYSTEM_MESSAGE>\n[Message] timestamp=t sender=${SESSION}/task-2 priority=HIGH content=Task id "${SESSION}/task-2" finished with result:\nCommand exited with code 0.\n\nCommand output:\nONE\r\n\nLog: file:///x\n</SYSTEM_MESSAGE>`,
          },
        ];
        const answer = {
          step_index: 6,
          type: "PLANNER_RESPONSE",
          status: "DONE",
          content: "It printed ONE.",
        };
        yield* fileSystem.writeFileString(transcriptPath, jsonl(beforeAnswer));
        const common = { transcriptPath };
        yield* fileSystem.writeFileString(
          eventsFile!,
          hookLine("Stop", { ...common, fullyIdle: false }) +
            hookLine("PostToolUse", {
              ...common,
              stepIdx: 2,
              toolCall: { name: "run_command", args: COMMAND },
              error: "",
            }) +
            hookLine("PreInvocation", { ...common, invocationNum: 0, initialNumSteps: 5 }) +
            hookLine("Stop", { ...common, fullyIdle: true }),
        );
        yield* Deferred.await(transcriptRead);
        // The card is held with its follow-up, so no run starts before the model has answered.
        assert.lengthOf(continuationRequests, 0);
        yield* fileSystem.writeFileString(transcriptPath, jsonl([...beforeAnswer, answer]));
        yield* Deferred.await(offered);

        yield* startTurn(2, {
          createdBy: "agent",
          creationSource: "provider",
          text: "Background task completed.",
        });
        const continuation = yield* collectTurn;
        const items = continuation.flatMap((event) =>
          event.type === "turn_item.updated" ? [event.turnItem] : [],
        );
        const command = items.findLast((item) => item.type === "command_execution");
        assert.equal(command?.type === "command_execution" && command.status, "completed");
        assert.equal(command?.type === "command_execution" && command.output, "ONE");
        const reply = items.findLast((item) => item.type === "assistant_message");
        assert.equal(reply?.type === "assistant_message" && reply.text, "It printed ONE.");
        assert.lengthOf(continuationRequests, 1);
        assert.isFalse(yield* session.hasPendingBackgroundWork!);
      }).pipe(Effect.provide(layerSession), Effect.scoped),
  );
});

describe("AntigravityAdapterV2 runtime mode ceiling", () => {
  const modesSetFor = (pickedMode: string) =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const crypto = yield* SecureRandom.SecureRandom;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
      const modesSet: Array<string> = [];
      const instanceId = ProviderInstanceId.make("antigravity-ceiling-test");
      const adapter = yield* makeAntigravityAdapterV2({
        instanceId,
        selfInvocation: yield* resolveSelfInvocation(),
        makeRuntime: (input) =>
          makeAntigravityAcpRuntime({
            ...input,
            childProcessSpawner,
            spawn: {
              command: process.execPath,
              args: [mockAgentPath],
              cwd: input.cwd,
              env: { T3_ACP_ANTIGRAVITY: "1" },
            },
          }).pipe(
            Effect.provideService(SecureRandom.SecureRandom, crypto),
            Effect.map((runtime): RuntimeService => ({
              ...runtime,
              setMode: (modeId) =>
                Effect.sync(() => {
                  modesSet.push(modeId);
                }).pipe(Effect.andThen(runtime.setMode(modeId))),
            })),
          ),
        withProcess: (_stop, task) => task,
        defaultModel: Effect.undefined,
      });
      const threadId = ThreadId.make("thread-antigravity-ceiling");
      yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-antigravity-ceiling"),
        modelSelection: {
          instanceId,
          model: "gemini-test-low",
          options: [{ id: "_t3/session-mode", value: pickedMode }],
        },
        runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "approval-required",
          interactionMode: "default",
          cwd: process.cwd(),
          maxRuntimeMode: "auto-accept-edits",
        }),
      });
      return modesSet;
    }).pipe(Effect.provide(layerSession), Effect.scoped);

  it.effect("does not apply a picked session mode above the policy ceiling", () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* modesSetFor("plan"), ["default"]);
      // A mode under the ceiling is still the user's to pick.
      assert.deepEqual(yield* modesSetFor("accept-edits"), ["default", "accept-edits"]);
    }),
  );
});

describe("AntigravityAdapterV2 session system prompt", () => {
  it.effect.each([true, false])(
    "carries PR linking once in the session setup or once per turn when the agent advertises the append: %s",
    (advertisesAppend) =>
      Effect.gen(function* () {
        const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const crypto = yield* SecureRandom.SecureRandom;
        const mockAgentPath = yield* path.fromFileUrl(
          new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
        );
        const logs = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-antigravity-log-" });
        const requestLog = path.join(logs, "requests.ndjson");
        type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
        const promptReceived = yield* Deferred.make<Parameters<RuntimeService["prompt"]>[0]>();
        const instanceId = ProviderInstanceId.make("antigravity-system-prompt-test");
        const adapter = yield* makeAntigravityAdapterV2({
          instanceId,
          selfInvocation: yield* resolveSelfInvocation(),
          makeRuntime: (input) =>
            makeAntigravityAcpRuntime({
              ...input,
              childProcessSpawner,
              spawn: {
                command: process.execPath,
                args: [mockAgentPath],
                cwd: input.cwd,
                env: {
                  T3_ACP_ANTIGRAVITY: "1",
                  T3_ACP_ANTIGRAVITY_SYSTEM_PROMPT_APPEND: advertisesAppend ? "1" : "0",
                  T3_ACP_REQUEST_LOG_PATH: requestLog,
                  T3_ACP_HANG_PROMPT_FOREVER: "1",
                },
              },
            }).pipe(
              Effect.provideService(SecureRandom.SecureRandom, crypto),
              Effect.map((runtime): RuntimeService => ({
                ...runtime,
                prompt: (request) =>
                  Deferred.succeed(promptReceived, request).pipe(
                    Effect.andThen(runtime.prompt(request)),
                  ),
              })),
            ),
          withProcess: (_stop, task) => task,
          defaultModel: Effect.undefined,
        });
        const workspace = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-ag-sp-" });
        const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: workspace,
        });
        const threadId = ThreadId.make("thread-antigravity-system-prompt");
        const modelSelection = { instanceId, model: "gemini-test-low" } as const;
        const session = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-antigravity-system-prompt"),
          modelSelection,
          runtimePolicy,
        });
        const providerThread = yield* session.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        const now = yield* DateTime.now;
        yield* session
          .startTurn({
            appThread: {
              createdBy: "user",
              creationSource: "web",
              id: threadId,
              projectId: ProjectId.make("project-antigravity-system-prompt"),
              title: "Antigravity system prompt",
              providerInstanceId: instanceId,
              modelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              activeProviderThreadId: providerThread.id,
              lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
              archivedAt: null,
              settledOverride: null,
              settledAt: null,
              lastVisitedAt: null,
              deletedAt: null,
            },
            threadId,
            runId: RunId.make("run-antigravity-system-prompt"),
            runOrdinal: 1,
            providerTurnOrdinal: 1,
            attemptId: RunAttemptId.make("attempt-antigravity-system-prompt"),
            rootNodeId: NodeId.make("node-antigravity-system-prompt"),
            providerThread,
            message: {
              createdBy: "user",
              creationSource: "web",
              messageId: MessageId.make("message-antigravity-system-prompt"),
              text: "open a PR",
              attachments: [],
            },
            modelSelection,
            runtimePolicy,
          })
          .pipe(Effect.forkScoped);
        const sent = JSON.stringify((yield* Deferred.await(promptReceived)).prompt);
        const sessionNew = (yield* fileSystem.readFileString(requestLog))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { method?: string; params?: { _meta?: unknown } })
          .find((request) => request.method === "session/new");
        const append = JSON.stringify(sessionNew?.params?._meta ?? null);
        // Identity stays per turn either way.
        assert.include(sent, "through the Antigravity harness, as gemini-test-low");
        if (advertisesAppend) {
          assert.include(append, "pull_request_linking");
          assert.notInclude(sent, "<pull_request_linking>");
        } else {
          assert.notInclude(append, "systemPrompt");
          assert.include(sent, "<pull_request_linking>");
        }
      }).pipe(Effect.provide(layerSession), Effect.scoped),
  );
});

it.layer(NodeServices.layer)("AntigravityAdapterV2 stored conversations", (it) => {
  const storedId = "8966e5d6-8efe-46f6-81e3-980b08dde3ba";
  const unknownId = "285ae7cd-c060-4536-856e-97727cabf594";

  const makeStoredFlavor = Effect.fn("AntigravityAdapterV2Test.makeStoredFlavor")(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const geminiDirectory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-agy-gemini-" });
    const conversations = path.join(geminiDirectory, "antigravity-cli", "conversations");
    yield* fileSystem.makeDirectory(conversations, { recursive: true });
    yield* fileSystem.writeFileString(path.join(conversations, `${storedId}.db`), "");
    const loaded: Array<string> = [];
    const stub = {
      loadSession: (sessionId: string) =>
        Effect.sync(() => {
          loaded.push(sessionId);
          return { sessionId };
        }),
      start: () => Effect.succeed({ sessionId: "fresh" }),
    };
    const flavor = makeAntigravityAcpAdapterFlavor({
      instanceId: ProviderInstanceId.make("antigravity-stored-test"),
      random: undefined as never,
      fileSystem,
      path,
      host: { paths: { attachmentsDir: "/attachments" } } as never,
      selfInvocation: undefined as never,
      makeRuntime: () => Effect.succeed(stub as never),
      withProcess: (_stop, task) => task,
      defaultModel: Effect.undefined,
      profileDirectory: geminiDirectory,
    });
    return { flavor, loaded };
  });

  // agy answers `session/load` for an unknown id with an empty session instead of an error.
  it.effect("loads a conversation agy stores and refuses one it does not", () =>
    Effect.gen(function* () {
      const { flavor, loaded } = yield* makeStoredFlavor();
      const runtime = yield* flavor.makeRuntime({ cwd: "/work" } as never);
      yield* runtime.loadSession(storedId, undefined as never);
      const error = yield* runtime.loadSession(unknownId, undefined as never).pipe(Effect.flip);
      assert.deepEqual(loaded, [storedId]);
      assert.equal(error._tag, "AcpRequestError");
      assert.include(error.message, "no conversation");
    }).pipe(Effect.scoped, Effect.provideService(SecureRandom.SecureRandom, undefined as never)),
  );

  // The shared adapter only falls back to a fresh session with a handoff when `start` fails on `session/load`.
  it.effect("fails start with a session/load error for a stored conversation that is gone", () =>
    Effect.gen(function* () {
      const { flavor } = yield* makeStoredFlavor();
      const runtime = yield* flavor.makeRuntime({
        cwd: "/work",
        resumeSessionId: unknownId,
      } as never);
      const error = yield* runtime.start().pipe(Effect.flip);
      assert.equal(error._tag, "AcpRequestError");
      assert.equal("method" in error ? error.method : undefined, "session/load");
    }).pipe(Effect.scoped, Effect.provideService(SecureRandom.SecureRandom, undefined as never)),
  );
});

it.layer(NodeServices.layer)("AntigravityAdapterV2 wake following", (it) => {
  const CHILD_TWO = "0f1e2d3c-4b5a-4968-8776-655443322110";
  const CALL_TWO = "call_2";
  const userStep = { type: 14, payload: new Uint8Array(), metadata: new Uint8Array() };
  const launchRows = (callId: string, child: string) => [
    userStep,
    plannerStep({ calls: [{ id: callId, name: "invoke_subagent", args: "{}" }] }),
    invokeStep({ callId, launches: [LAUNCH], children: [child] }),
    plannerStep({ text: "I have launched a subagent." }),
  ];
  const launchFrame = (toolCallId: string) =>
    ({
      toolCallId,
      title: "Run invoke_subagent",
      kind: "other",
      rawInput: { Prompt: LAUNCH.prompt },
    }) as const;

  const setup = Effect.fn("AntigravityAdapterV2Test.setupWake")(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const profile = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-agy-wake-" });
    const conversations = path.join(profile, ...ANTIGRAVITY_CONVERSATION_SEGMENTS);
    yield* fileSystem.makeDirectory(conversations, { recursive: true });
    const file = path.join(conversations, `${ROOT}.db`);
    writeConversation(file, launchRows(CALL_ID, CHILD));
    const delivered: Array<EffectAcpSchema.SessionUpdate> = [];
    let handler: Parameters<
      AcpSessionRuntime.AcpSessionRuntime["Service"]["handleSessionUpdate"]
    >[0];
    const settled = yield* Deferred.make<void>();
    const record: typeof handler = ({ update }) =>
      Effect.sync(() => {
        delivered.push(update);
        if (
          update.sessionUpdate === "tool_call_update" &&
          (update.status === "completed" || update.status === "failed")
        ) {
          Deferred.doneUnsafe(settled, Effect.void);
        }
      });
    const stub = {
      handleSessionUpdate: (next: typeof handler) =>
        Effect.sync(() => {
          handler = next;
        }),
      prompt: () => Effect.succeed({ stopReason: "end_turn" as const }),
      cancel: Effect.void,
    };
    const flavor = makeAntigravityAcpAdapterFlavor({
      instanceId: ProviderInstanceId.make("antigravity-wake-follow"),
      random: undefined as never,
      fileSystem,
      path,
      host: { paths: { attachmentsDir: "/attachments" } } as never,
      selfInvocation: undefined as never,
      makeRuntime: () => Effect.succeed(stub as never),
      withProcess: (_stop, task) => task,
      defaultModel: Effect.undefined,
      profileDirectory: profile,
    });
    const runtime = yield* flavor.makeRuntime({ cwd: "/work" } as never);
    yield* runtime.handleSessionUpdate(record);
    const launch = (toolCallId: string) =>
      handler({
        sessionId: ROOT,
        update: { sessionUpdate: "tool_call", ...launchFrame(toolCallId), status: "in_progress" },
      });
    return { runtime, file, delivered, settled, launch };
  });

  const completions = (delivered: ReadonlyArray<EffectAcpSchema.SessionUpdate>) =>
    delivered.flatMap((update) =>
      update.sessionUpdate === "tool_call_update" && update.status === "completed"
        ? [update.toolCallId]
        : [],
    );

  it.effect("does not carry a cancelled turn's launch into the next turn", () =>
    Effect.gen(function* () {
      const { runtime, file, delivered, settled, launch } = yield* setup();
      yield* launch(CALL_ID);
      yield* runtime.prompt({ prompt: [] });
      yield* TestClock.adjust("5 seconds");
      yield* runtime.cancel;
      // The next turn's log also holds a late report for the cancelled launch.
      appendSteps(
        file,
        [
          ...launchRows(CALL_TWO, CHILD_TWO),
          wakeMessageStep(CHILD, "stale-report"),
          plannerStep({ text: "stale-answer" }),
          wakeMessageStep(CHILD_TWO, "two"),
          plannerStep({ text: "two answer" }),
        ],
        4,
      );
      yield* runtime.prompt({ prompt: [] });
      yield* launch(CALL_TWO);
      yield* Deferred.await(settled);
      assert.deepEqual(completions(delivered), [CALL_TWO]);
      assert.notInclude(JSON.stringify(delivered), "stale-");
    }).pipe(Effect.scoped, Effect.provideService(SecureRandom.SecureRandom, undefined as never)),
  );

  it.effect("fails a launch that never reports back once it is too old", () =>
    Effect.gen(function* () {
      const { delivered, settled, launch } = yield* setup();
      yield* launch(CALL_ID);
      yield* TestClock.adjust("31 minutes");
      yield* Deferred.await(settled);
      const failed = delivered.find(
        (update) => update.sessionUpdate === "tool_call_update" && update.status === "failed",
      );
      assert.equal(failed?.sessionUpdate === "tool_call_update" && failed.toolCallId, CALL_ID);
    }).pipe(Effect.scoped, Effect.provideService(SecureRandom.SecureRandom, undefined as never)),
  );
});
