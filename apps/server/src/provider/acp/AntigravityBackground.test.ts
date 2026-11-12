import { assert, describe, it } from "@effect/vitest";

import {
  ANTIGRAVITY_WAKE_META,
  makeAntigravityBackgroundFollower,
  parseAntigravityTaskMessage,
} from "./AntigravityBackground.ts";
import type { AntigravityHookEvent, AntigravityHookName } from "./AntigravityHookEvents.ts";
import {
  parseAntigravityTranscript,
  type AntigravityTranscriptStep,
} from "./AntigravityTranscript.ts";

// Trimmed from `agy acp` 1.5.3 runs: one prompt that backgrounds work, then the wakes it caused.
const ROOT = "834996b4-74de-4411-a7d7-1863795f730b";
const TRANSCRIPT_PATH = `/gemini/antigravity-cli/brain/${ROOT}/.system_generated/logs/transcript_full.jsonl`;

const ONE = {
  CommandLine: "sleep 15 && echo ONE",
  IsDaemon: false,
  WaitMsBeforeAsync: 500,
  toolSummary: "Run first command",
};
const TWO = {
  CommandLine: "sleep 28 && echo TWO",
  IsDaemon: false,
  WaitMsBeforeAsync: 500,
  toolSummary: "Run second command",
};

const jsonl = (steps: ReadonlyArray<object>) =>
  steps.map((step) => JSON.stringify(step)).join("\n");

const systemMessage = (sender: string, content: string) =>
  `The following is a <SYSTEM_MESSAGE> not actually sent by the user.\n\n<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-12T18:25:10Z sender=${sender} priority=MESSAGE_PRIORITY_HIGH content=${content}\n</SYSTEM_MESSAGE>`;
const finished = (task: number, output: string) =>
  systemMessage(
    `${ROOT}/task-${task}`,
    `Task id "${ROOT}/task-${task}" finished with result:\nCommand exited with code 0.\n\nCommand output:\n${output}\r\n\nLog: file:///x/tasks/task-${task}.log`,
  );

const launchSteps = [
  { step_index: 0, type: "USER_INPUT", status: "DONE", content: "<USER_REQUEST>…</USER_REQUEST>" },
  {
    step_index: 1,
    type: "PLANNER_RESPONSE",
    status: "DONE",
    tool_calls: [
      { name: "run_command", args: ONE },
      { name: "run_command", args: TWO },
    ],
  },
  { step_index: 2, type: "GENERIC", status: "RUNNING", content: `task id: ${ROOT}/task-2` },
  { step_index: 3, type: "GENERIC", status: "RUNNING", content: `task id: ${ROOT}/task-3` },
  { step_index: 4, type: "PLANNER_RESPONSE", status: "DONE", content: "started" },
];
const firstWake = [
  { step_index: 5, type: "SYSTEM_MESSAGE", status: "DONE", content: finished(2, "ONE") },
  {
    step_index: 6,
    type: "PLANNER_RESPONSE",
    status: "DONE",
    content: "The first command has finished.\n\nONE",
  },
];
const secondWake = [
  { step_index: 7, type: "SYSTEM_MESSAGE", status: "DONE", content: finished(3, "TWO") },
  {
    step_index: 8,
    type: "PLANNER_RESPONSE",
    status: "DONE",
    content: "The second command has finished.\n\nTWO\n<!-- GOAL_COMPLETE -->",
  },
];

const transcript = (
  ...parts: ReadonlyArray<ReadonlyArray<object>>
): ReadonlyArray<AntigravityTranscriptStep> => parseAntigravityTranscript(jsonl(parts.flat()), 0);

const hook = (
  name: AntigravityHookName,
  fields: Partial<Omit<AntigravityHookEvent, "name">> = {},
): AntigravityHookEvent => ({
  name,
  conversationId: ROOT,
  transcriptPath: TRANSCRIPT_PATH,
  ...fields,
});

const postToolUse = (stepIdx: number, args: unknown, name = "run_command") =>
  hook("PostToolUse", { stepIdx, toolCall: { name, args }, error: "" });

function launched(...calls: ReadonlyArray<{ id: string; name?: string; args: unknown }>) {
  const follower = makeAntigravityBackgroundFollower();
  follower.sessionStarted(ROOT);
  follower.promptStarted();
  for (const call of calls) {
    follower.toolObserved({
      toolCallId: call.id,
      name: call.name ?? "run_command",
      rawInput: call.args,
      status: "open",
    });
  }
  follower.hook(hook("PreInvocation", { invocationNum: 0, initialNumSteps: 1 }));
  follower.hook(hook("PreInvocation", { invocationNum: 1, initialNumSteps: 4 }));
  follower.hook(hook("Stop", { fullyIdle: false }));
  follower.promptReturned();
  return follower;
}

const summarize = (updates: ReadonlyArray<object>) =>
  updates.map((update) => {
    const fields = update as Record<string, unknown>;
    const text = (fields.content as { text?: string } | undefined)?.text;
    return [fields.sessionUpdate, fields.toolCallId ?? text, fields.status ?? null];
  });

const isWake = (update: object) =>
  (update as { _meta?: Record<string, unknown> })._meta?.[ANTIGRAVITY_WAKE_META] === true;

describe("AntigravityBackgroundFollower", () => {
  it("holds a finished task until its wake ends, then delivers card and follow-up together", () => {
    const follower = launched({ id: "call_1", args: ONE });
    assert.deepEqual(follower.pendingToolCallIds(), ["call_1"]);

    // Nothing is reported while the model is still working on its follow-up.
    assert.deepEqual(follower.hook(postToolUse(2, ONE)).updates, []);
    assert.isTrue(follower.holding());
    assert.deepEqual(follower.pendingToolCallIds(), []);
    assert.deepEqual(
      follower.hook(hook("PreInvocation", { invocationNum: 0, initialNumSteps: 5 })).updates,
      [],
    );
    const stop = follower.hook(hook("Stop", { fullyIdle: true }));
    assert.equal(stop.read?.transcriptPath, TRANSCRIPT_PATH);

    const result = follower.transcript(transcript(launchSteps, firstWake));
    assert.isFalse(result.incomplete);
    assert.deepEqual(summarize(result.updates), [
      ["tool_call_update", "call_1", "completed"],
      ["agent_message_chunk", "The first command has finished.\n\nONE", null],
    ]);
    assert.deepEqual((result.updates[0] as { rawOutput?: unknown }).rawOutput, {
      combinedOutput: "ONE",
      exitCode: 0,
    });
    assert.isTrue(result.updates.every(isWake));
    assert.isFalse(follower.holding());
    assert.deepEqual(follower.transcript(transcript(launchSteps, firstWake)).updates, []);
  });

  it("reports a held completion on its own when the wake never ends", () => {
    const follower = launched({ id: "call_1", args: ONE });
    follower.hook(postToolUse(2, ONE));
    assert.deepEqual(summarize(follower.flush()), [["tool_call_update", "call_1", "completed"]]);
    assert.deepEqual(follower.flush(), []);
  });

  it("follows two tasks in turn and strips the goal marker", () => {
    const follower = launched({ id: "call_1", args: ONE }, { id: "call_2", args: TWO });
    follower.hook(postToolUse(2, ONE));
    follower.hook(hook("PreInvocation", { invocationNum: 0, initialNumSteps: 5 }));
    follower.hook(hook("Stop", { fullyIdle: false }));
    const first = follower.transcript(transcript(launchSteps, firstWake));
    assert.deepEqual(
      summarize(first.updates).map((update) => update[0]),
      ["tool_call_update", "agent_message_chunk"],
    );
    assert.deepEqual(follower.pendingToolCallIds(), ["call_2"]);

    follower.hook(postToolUse(3, TWO));
    follower.hook(hook("PreInvocation", { invocationNum: 0, initialNumSteps: 7 }));
    follower.hook(hook("Stop", { fullyIdle: true }));
    const second = follower.transcript(transcript(launchSteps, firstWake, secondWake));
    assert.deepEqual(summarize(second.updates), [
      ["tool_call_update", "call_2", "completed"],
      ["agent_message_chunk", "The second command has finished.\n\nTWO", null],
    ]);
    assert.deepEqual(follower.pendingToolCallIds(), []);
  });

  it("follows a schedule timer", () => {
    const args = { DurationSeconds: 20, Prompt: "Reply with the single word PING" };
    const follower = launched({ id: "call_s", name: "schedule", args });
    follower.hook(postToolUse(2, args, "schedule"));
    follower.hook(hook("PreInvocation", { invocationNum: 0, initialNumSteps: 4 }));
    follower.hook(hook("Stop", { fullyIdle: true }));
    const result = follower.transcript(
      transcript([
        {
          step_index: 4,
          type: "SYSTEM_MESSAGE",
          status: "DONE",
          content: systemMessage(`${ROOT}/task-2`, "Reply with the single word PING"),
        },
        { step_index: 5, type: "PLANNER_RESPONSE", status: "DONE", content: "PING" },
      ]),
    );
    assert.deepEqual(summarize(result.updates), [
      ["tool_call_update", "call_s", "completed"],
      ["agent_message_chunk", "PING", null],
    ]);
  });

  it("leaves subagent wakes and foreign conversations alone", () => {
    const follower = launched({ id: "call_x", name: "invoke_subagent", args: {} });
    assert.deepEqual(follower.pendingToolCallIds(), []);
    assert.deepEqual(follower.hook(postToolUse(2, {}, "invoke_subagent")).updates, []);
    // A wake with no background task finishing before it is a subagent report.
    follower.hook(hook("PreInvocation", { invocationNum: 2, initialNumSteps: 4 }));
    const stop = follower.hook(hook("Stop", { fullyIdle: true }));
    assert.isUndefined(stop.read);
    assert.deepEqual(follower.transcript(transcript(launchSteps, firstWake)).updates, []);

    const other = launched({ id: "call_1", args: ONE });
    const child = other.hook({ ...postToolUse(2, ONE), conversationId: "child" });
    assert.deepEqual(child.updates, []);
    assert.deepEqual(other.pendingToolCallIds(), ["call_1"]);
  });

  it("completes a task that ends during a prompt without starting a wake", () => {
    const follower = launched({ id: "call_1", args: ONE });
    follower.promptStarted();
    const done = follower.hook(postToolUse(2, ONE));
    assert.deepEqual(summarize(done.updates), [["tool_call_update", "call_1", "completed"]]);
    assert.isFalse(done.updates.some(isWake));
    follower.hook(hook("PreInvocation", { invocationNum: 1, initialNumSteps: 5 }));
    follower.hook(hook("Stop", { fullyIdle: true }));
    const result = follower.transcript(transcript(launchSteps, firstWake));
    assert.isFalse(result.updates.some((update) => update.sessionUpdate === "agent_message_chunk"));
  });

  it("does not treat a command that finished inside its prompt as background work", () => {
    const follower = makeAntigravityBackgroundFollower();
    follower.sessionStarted(ROOT);
    follower.promptStarted();
    follower.toolObserved({
      toolCallId: "call_1",
      name: "run_command",
      rawInput: ONE,
      status: "open",
    });
    follower.toolObserved({
      toolCallId: "call_1",
      name: "run_command",
      rawInput: ONE,
      status: "settled",
    });
    follower.hook(hook("Stop", { fullyIdle: false }));
    follower.promptReturned();
    assert.deepEqual(follower.pendingToolCallIds(), []);
    assert.deepEqual(follower.hook(postToolUse(2, ONE)).updates, []);
  });

  it("waits for a follow-up the transcript has not written yet", () => {
    const follower = launched({ id: "call_1", args: ONE });
    follower.hook(postToolUse(2, ONE));
    follower.hook(hook("PreInvocation", { invocationNum: 0, initialNumSteps: 5 }));
    follower.hook(hook("Stop", { fullyIdle: true }));
    const early = follower.transcript(transcript(launchSteps, firstWake.slice(0, 1)));
    assert.isTrue(early.incomplete);
    assert.isFalse(early.updates.some((update) => update.sessionUpdate === "agent_message_chunk"));
    const late = follower.transcript(transcript(launchSteps, firstWake));
    assert.isFalse(late.incomplete);
    assert.deepEqual(summarize(late.updates).at(-1)?.[0], "agent_message_chunk");
  });

  it("emits the tools a follow-up ran and tracks one it backgrounds", () => {
    const follower = launched({ id: "call_1", args: ONE });
    follower.hook(postToolUse(2, ONE));
    follower.hook(hook("PreInvocation", { invocationNum: 0, initialNumSteps: 5 }));
    follower.hook(hook("Stop", { fullyIdle: false }));
    const THREE = { CommandLine: "sleep 9", IsDaemon: false };
    const result = follower.transcript(
      transcript(launchSteps, [
        firstWake[0]!,
        {
          step_index: 6,
          type: "PLANNER_RESPONSE",
          status: "DONE",
          content: "Checking.",
          tool_calls: [
            { name: "run_command", args: { CommandLine: "ls" } },
            { name: "run_command", args: THREE },
          ],
        },
        { step_index: 7, type: "GENERIC", status: "DONE", content: "a.txt" },
        { step_index: 8, type: "GENERIC", status: "RUNNING", content: `task id: ${ROOT}/task-8` },
      ]),
    );
    assert.deepEqual(summarize(result.updates), [
      ["tool_call_update", "call_1", "completed"],
      ["agent_message_chunk", "Checking.", null],
      ["tool_call", `agy-${ROOT}-6-0`, "in_progress"],
      ["tool_call", `agy-${ROOT}-6-1`, "in_progress"],
      ["tool_call_update", `agy-${ROOT}-6-0`, "completed"],
    ]);
    assert.deepEqual(follower.pendingToolCallIds(), [`agy-${ROOT}-6-1`]);
    follower.hook(postToolUse(8, THREE));
    assert.deepEqual(summarize(follower.flush()), [
      ["tool_call_update", `agy-${ROOT}-6-1`, "completed"],
    ]);
  });

  it("drops its tasks when the turn is stopped", () => {
    const follower = launched({ id: "call_1", args: ONE });
    follower.abandon();
    assert.deepEqual(follower.hook(postToolUse(2, ONE)).updates, []);
  });

  it("ends a command that was never backgrounded when its prompt fails", () => {
    const follower = makeAntigravityBackgroundFollower();
    follower.sessionStarted(ROOT);
    follower.promptStarted();
    follower.toolObserved({
      toolCallId: "call_1",
      name: "run_command",
      rawInput: ONE,
      status: "open",
    });
    assert.deepEqual(summarize(follower.failUnconfirmed("The turn failed.")), [
      ["tool_call_update", "call_1", "failed"],
    ]);
    assert.deepEqual(follower.failUnconfirmed("again"), []);

    const backgrounded = launched({ id: "call_2", args: TWO });
    assert.deepEqual(backgrounded.failUnconfirmed("x"), []);
  });

  it("marks tasks lost only while a prompt can show it", () => {
    const idle = launched({ id: "call_1", args: ONE });
    assert.deepEqual(idle.lost(), []);
    idle.promptStarted();
    assert.deepEqual(summarize(idle.lost()), [["tool_call_update", "call_1", "failed"]]);
  });
});

describe("parseAntigravityTaskMessage", () => {
  it("reads the task, exit code and output of a finished command", () => {
    assert.deepEqual(parseAntigravityTaskMessage(finished(2, "ONE\nTWO")), {
      stepIdx: 2,
      output: "ONE\nTWO",
      exitCode: 0,
    });
    assert.deepEqual(parseAntigravityTaskMessage(systemMessage(`${ROOT}/task-4`, "Ping")), {
      stepIdx: 4,
      output: undefined,
      exitCode: undefined,
    });
    assert.isUndefined(parseAntigravityTaskMessage("hello"));
  });
});
