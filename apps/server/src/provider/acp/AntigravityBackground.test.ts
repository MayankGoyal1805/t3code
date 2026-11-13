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

const postToolUse = (stepIdx: number, args: unknown, name = "run_command", id?: string) =>
  hook("PostToolUse", {
    stepIdx,
    toolCall: { name, args, ...(id === undefined ? {} : { id }) },
    error: "",
  });
const preToolUse = (stepIdx: number, args: unknown, id?: string) =>
  hook("PreToolUse", {
    stepIdx,
    toolCall: { name: "run_command", args, ...(id === undefined ? {} : { id }) },
  });
const preInvocation = (initialNumSteps: number) =>
  hook("PreInvocation", { invocationNum: 0, initialNumSteps });

type Follower = ReturnType<typeof makeAntigravityBackgroundFollower>;

/** What agy's hook handler and the transcript read after it would deliver, in one call. */
function feed(
  follower: Follower,
  event: AntigravityHookEvent,
  steps: ReadonlyArray<AntigravityTranscriptStep> = [],
  taskLog?: string,
) {
  const step = follower.hook(event);
  const log = step.read?.taskLog;
  const read =
    step.read === undefined
      ? []
      : follower.ingest({
          steps,
          ...(log === undefined || taskLog === undefined
            ? {}
            : { taskLog: { toolCallId: log.toolCallId, text: taskLog } }),
        });
  return [...step.updates, ...read];
}

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

const chunk = (value: string) =>
  ({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: value } }) as const;

describe("AntigravityBackgroundFollower", () => {
  it("completes the card the moment its command ends, with the output from its task log", () => {
    const follower = launched({ id: "call_1", args: ONE });
    assert.deepEqual(follower.pendingToolCallIds(), ["call_1"]);

    const post = follower.hook(postToolUse(2, ONE, "run_command", "call_1"));
    assert.deepEqual(post.updates, []);
    assert.equal(post.read?.transcriptPath, TRANSCRIPT_PATH);
    assert.deepEqual(post.read?.taskLog, {
      toolCallId: "call_1",
      path: `/gemini/antigravity-cli/brain/${ROOT}/.system_generated/tasks/task-2.log`,
    });
    assert.isTrue(follower.wakeInProgress());
    assert.deepEqual(follower.pendingToolCallIds(), []);

    // The wake message and the model's answer are not in the transcript yet.
    const updates = follower.ingest({
      steps: transcript(launchSteps),
      taskLog: { toolCallId: "call_1", text: "ONE\r\n" },
    });
    assert.deepEqual(summarize(updates), [["tool_call_update", "call_1", "completed"]]);
    assert.deepEqual((updates[0] as { rawOutput?: unknown }).rawOutput, { combinedOutput: "ONE" });
    assert.isTrue(updates.every(isWake));
    assert.isTrue(follower.wakeInProgress());
  });

  it("corrects the card when the transcript later reports a failing exit code", () => {
    const follower = launched({ id: "call_1", args: ONE });
    feed(follower, postToolUse(2, ONE), transcript(launchSteps), "ONE\r\n");
    const failure = systemMessage(
      `${ROOT}/task-2`,
      `Task id "${ROOT}/task-2" finished with result:\nCommand exited with code 3.\n\nCommand output:\nONE\r\n\nLog: file:///x`,
    );
    const updates = feed(follower, preInvocation(5), [
      ...transcript(launchSteps),
      ...transcript([{ step_index: 5, type: "SYSTEM_MESSAGE", status: "DONE", content: failure }]),
    ]);
    assert.deepEqual(summarize(updates), [["tool_call_update", "call_1", "failed"]]);
    assert.deepEqual((updates[0] as { rawOutput?: unknown }).rawOutput, {
      combinedOutput: "ONE",
      exitCode: 3,
    });
  });

  it("streams a wake into one run: reply text and each tool when it starts, until Stop", () => {
    const follower = launched({ id: "call_1", args: ONE });
    const THREE = { CommandLine: "sleep 9", IsDaemon: false };
    const wakeStart = [{ ...firstWake[0]! }];
    const decided = {
      step_index: 6,
      type: "PLANNER_RESPONSE",
      status: "DONE",
      content: "ONE is done. Starting the next one.",
      tool_calls: [{ name: "run_command", args: THREE }],
    };
    const launching = {
      step_index: 7,
      type: "GENERIC",
      status: "RUNNING",
      content: `task id: ${ROOT}/task-7`,
    };
    const waiting = {
      step_index: 8,
      type: "PLANNER_RESPONSE",
      status: "DONE",
      content: "Waiting for it.",
    };

    const completion = feed(follower, postToolUse(2, ONE, "run_command", "call_1"), [], "ONE\r\n");
    assert.deepEqual(summarize(completion), [["tool_call_update", "call_1", "completed"]]);
    assert.deepEqual(feed(follower, preInvocation(5), transcript(launchSteps, wakeStart)), []);

    // The model has answered with a tool call: its card appears as the tool begins, under agy's id.
    const started = feed(
      follower,
      preToolUse(7, THREE, "call_three"),
      transcript(launchSteps, wakeStart, [decided]),
    );
    assert.deepEqual(summarize(started), [
      ["agent_message_chunk", "ONE is done. Starting the next one.", null],
      ["tool_call", "call_three", "in_progress"],
    ]);
    assert.isTrue(started.every(isWake));

    // The command went to the background; the closing reply is held until the wake stops.
    const backgrounded = feed(
      follower,
      preInvocation(8),
      transcript(launchSteps, wakeStart, [decided, launching, waiting]),
    );
    assert.deepEqual(backgrounded, []);
    assert.isTrue(follower.wakeInProgress());
    assert.deepEqual(follower.pendingToolCallIds(), ["call_three"]);

    const stopped = feed(
      follower,
      hook("Stop", { fullyIdle: false }),
      transcript(launchSteps, wakeStart, [decided, launching, waiting]),
    );
    assert.deepEqual(summarize(stopped), [["agent_message_chunk", "Waiting for it.", null]]);
    assert.isFalse(follower.wakeInProgress());
    assert.isFalse(follower.awaitingFinal());
    // The command keeps running after the run ends.
    assert.deepEqual(follower.pendingToolCallIds(), ["call_three"]);

    const finished = feed(
      follower,
      postToolUse(7, THREE, "run_command", "call_three"),
      [],
      "9\r\n",
    );
    assert.deepEqual(summarize(finished), [["tool_call_update", "call_three", "completed"]]);
    assert.isTrue(follower.wakeInProgress());
  });

  it("runs a foreground tool of the wake from its start to its result", () => {
    const follower = launched({ id: "call_1", args: ONE });
    const LS = { CommandLine: "ls" };
    const decided = {
      step_index: 6,
      type: "PLANNER_RESPONSE",
      status: "DONE",
      tool_calls: [{ name: "run_command", args: LS }],
    };
    feed(follower, postToolUse(2, ONE, "run_command", "call_1"), [], "ONE");
    feed(follower, preInvocation(5), transcript(launchSteps, firstWake.slice(0, 1)));
    const started = feed(
      follower,
      preToolUse(7, LS, "call_ls"),
      transcript(launchSteps, [firstWake[0]!, decided]),
    );
    assert.deepEqual(summarize(started), [["tool_call", "call_ls", "in_progress"]]);
    const result = { step_index: 7, type: "GENERIC", status: "DONE", content: "a.txt" };
    const finished = feed(
      follower,
      preInvocation(8),
      transcript(launchSteps, [firstWake[0]!, decided, result]),
    );
    assert.deepEqual(summarize(finished), [["tool_call_update", "call_ls", "completed"]]);
    assert.deepEqual(follower.pendingToolCallIds(), []);
  });

  // Steps 33 to 35 of a real transcript: a reply with a malformed call, agy's error, the retry.
  it("shows only the retry when agy rejected an attempt", () => {
    const follower = launched({ id: "call_1", args: ONE });
    const rejected = {
      step_index: 6,
      type: "PLANNER_RESPONSE",
      status: "DONE",
      content: "**30s** finished. Started **40s** and waiting.\nAll four commands completed.",
    };
    const error = {
      step_index: 7,
      type: "ERROR_MESSAGE",
      status: "DONE",
      content:
        "Error: Your previous response contained an improperly formatted function call: Malformed function call.\nRetries remaining: 3",
    };
    const retry = {
      step_index: 8,
      type: "PLANNER_RESPONSE",
      status: "DONE",
      content: "**30s** finished. Started **40s** and waiting.",
    };
    feed(follower, postToolUse(2, ONE, "run_command", "call_1"), [], "ONE");
    // Read while the rejected attempt is the last step: it is not delivered yet.
    assert.deepEqual(
      feed(follower, preInvocation(5), transcript(launchSteps, [firstWake[0]!, rejected])),
      [],
    );
    assert.deepEqual(
      feed(follower, preInvocation(5), transcript(launchSteps, [firstWake[0]!, rejected, error])),
      [],
    );
    const updates = feed(
      follower,
      hook("Stop", { fullyIdle: true }),
      transcript(launchSteps, [firstWake[0]!, rejected, error, retry]),
    );
    assert.deepEqual(summarize(updates), [
      ["agent_message_chunk", "**30s** finished. Started **40s** and waiting.", null],
    ]);
    assert.isFalse(follower.wakeInProgress());
  });

  it("keeps the run open until the follow-up's last step is written", () => {
    const follower = launched({ id: "call_1", args: ONE });
    feed(follower, postToolUse(2, ONE, "run_command", "call_1"), [], "ONE");
    feed(follower, preInvocation(5), transcript(launchSteps, firstWake.slice(0, 1)));
    // Stop lands before the transcript has the answer.
    assert.deepEqual(
      feed(
        follower,
        hook("Stop", { fullyIdle: true }),
        transcript(launchSteps, firstWake.slice(0, 1)),
      ),
      [],
    );
    assert.isTrue(follower.awaitingFinal());
    assert.isTrue(follower.wakeInProgress());
    const late = follower.ingest({ steps: transcript(launchSteps, firstWake) });
    assert.deepEqual(summarize(late), [
      ["agent_message_chunk", "The first command has finished.\n\nONE", null],
    ]);
    assert.isFalse(follower.awaitingFinal());
    assert.isFalse(follower.wakeInProgress());
  });

  it("gives up on a wake that never finishes and completes what it left open", () => {
    const follower = launched({ id: "call_1", args: ONE });
    feed(follower, postToolUse(2, ONE, "run_command", "call_1"), [], "ONE");
    feed(follower, preInvocation(5), transcript(launchSteps, firstWake.slice(0, 1)));
    follower.hook(hook("Stop", { fullyIdle: true }));
    assert.deepEqual(follower.endWake(), []);
    assert.isFalse(follower.wakeInProgress());
    assert.isFalse(follower.awaitingFinal());
  });

  it("follows two tasks in turn and strips the goal marker", () => {
    const follower = launched({ id: "call_1", args: ONE }, { id: "call_2", args: TWO });
    feed(follower, postToolUse(2, ONE), [], "ONE");
    feed(follower, preInvocation(5), transcript(launchSteps, firstWake));
    const first = feed(
      follower,
      hook("Stop", { fullyIdle: false }),
      transcript(launchSteps, firstWake),
    );
    assert.deepEqual(
      summarize(first).map((update) => update[0]),
      ["agent_message_chunk"],
    );
    assert.deepEqual(follower.pendingToolCallIds(), ["call_2"]);

    const card = feed(follower, postToolUse(3, TWO), [], "TWO");
    assert.deepEqual(summarize(card), [["tool_call_update", "call_2", "completed"]]);
    feed(follower, preInvocation(7), transcript(launchSteps, firstWake, secondWake));
    const second = feed(
      follower,
      hook("Stop", { fullyIdle: true }),
      transcript(launchSteps, firstWake, secondWake),
    );
    assert.deepEqual(summarize(second), [
      ["agent_message_chunk", "The second command has finished.\n\nTWO", null],
    ]);
    assert.deepEqual(follower.pendingToolCallIds(), []);
  });

  it("follows a schedule timer", () => {
    const args = { DurationSeconds: 20, Prompt: "Reply with the single word PING" };
    const follower = launched({ id: "call_s", name: "schedule", args });
    const wakeSteps = [
      {
        step_index: 4,
        type: "SYSTEM_MESSAGE",
        status: "DONE",
        content: systemMessage(`${ROOT}/task-2`, "Reply with the single word PING"),
      },
      { step_index: 5, type: "PLANNER_RESPONSE", status: "DONE", content: "PING" },
    ];
    const card = feed(follower, postToolUse(2, args, "schedule"), []);
    assert.deepEqual(summarize(card), [["tool_call_update", "call_s", "completed"]]);
    feed(follower, preInvocation(4), transcript(wakeSteps));
    const result = feed(follower, hook("Stop", { fullyIdle: true }), transcript(wakeSteps));
    assert.deepEqual(summarize(result), [["agent_message_chunk", "PING", null]]);
  });

  it("leaves subagent wakes and foreign conversations alone", () => {
    const follower = launched({ id: "call_x", name: "invoke_subagent", args: {} });
    assert.deepEqual(follower.pendingToolCallIds(), []);
    assert.deepEqual(follower.hook(postToolUse(2, {}, "invoke_subagent")).updates, []);
    // A wake with no background task finishing before it is a subagent report.
    assert.isUndefined(
      follower.hook(hook("PreInvocation", { invocationNum: 2, initialNumSteps: 4 })).read,
    );
    assert.isUndefined(follower.hook(hook("Stop", { fullyIdle: true })).read);
    assert.isFalse(follower.wakeInProgress());

    const other = launched({ id: "call_1", args: ONE });
    const child = other.hook({ ...postToolUse(2, ONE), conversationId: "child" });
    assert.deepEqual(child.updates, []);
    assert.isUndefined(child.read);
    assert.deepEqual(other.pendingToolCallIds(), ["call_1"]);
  });

  it("completes a task that ends during a prompt without starting a wake", () => {
    const follower = launched({ id: "call_1", args: ONE });
    follower.promptStarted();
    const done = feed(follower, postToolUse(2, ONE), [], "ONE");
    assert.deepEqual(summarize(done), [["tool_call_update", "call_1", "completed"]]);
    assert.isFalse(done.some(isWake));
    assert.isFalse(follower.wakeInProgress());
    const rest = feed(follower, preInvocation(5), transcript(launchSteps, firstWake));
    assert.isFalse(rest.some((update) => update.sessionUpdate === "agent_message_chunk"));
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
    assert.isFalse(follower.wakeInProgress());
  });

  it("drops its tasks when the turn is stopped", () => {
    const follower = launched({ id: "call_1", args: ONE });
    follower.abandon();
    assert.isUndefined(follower.hook(postToolUse(2, ONE)).read);
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

// Two background commands from one prompt that follows an earlier wake, as agy 1.5.x recorded them.
describe("AntigravityBackgroundFollower with two tasks after an earlier wake", () => {
  const priorWake = [
    {
      step_index: 0,
      type: "USER_INPUT",
      status: "DONE",
      content: "<USER_REQUEST>A</USER_REQUEST>",
    },
    { step_index: 3, type: "PLANNER_RESPONSE", status: "DONE", content: "started" },
    { step_index: 4, type: "SYSTEM_MESSAGE", status: "DONE", content: finished(2, "ZEBRA7") },
    { step_index: 5, type: "PLANNER_RESPONSE", status: "DONE", content: "ZEBRA7 done." },
  ];
  const second = [
    {
      step_index: 6,
      type: "USER_INPUT",
      status: "DONE",
      content: "<USER_REQUEST>B</USER_REQUEST>",
    },
    {
      step_index: 7,
      type: "PLANNER_RESPONSE",
      status: "DONE",
      tool_calls: [
        { name: "run_command", args: ONE },
        { name: "run_command", args: TWO },
      ],
    },
    { step_index: 8, type: "GENERIC", status: "RUNNING", content: `task id: ${ROOT}/task-8` },
    { step_index: 9, type: "GENERIC", status: "RUNNING", content: `task id: ${ROOT}/task-9` },
    { step_index: 10, type: "PLANNER_RESPONSE", status: "DONE", content: "started" },
    { step_index: 11, type: "SYSTEM_MESSAGE", status: "DONE", content: finished(8, "ONE") },
    { step_index: 12, type: "PLANNER_RESPONSE", status: "DONE", content: "ONE finished." },
    { step_index: 13, type: "SYSTEM_MESSAGE", status: "DONE", content: finished(9, "TWO") },
    { step_index: 14, type: "PLANNER_RESPONSE", status: "DONE", content: "TWO finished." },
  ];

  function afterFirstWake() {
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
      toolCallId: "call_2",
      name: "run_command",
      rawInput: TWO,
      status: "open",
    });
    follower.hook(hook("PreInvocation", { invocationNum: 0, initialNumSteps: 7 }));
    follower.hook(hook("PreInvocation", { invocationNum: 1, initialNumSteps: 10 }));
    follower.hook(hook("Stop", { fullyIdle: false }));
    follower.promptReturned();
    return follower;
  }

  it("delivers each wake with only its own card and text, though the first Stop is not idle", () => {
    const follower = afterFirstWake();
    const steps = transcript(priorWake, second);
    const card = feed(follower, postToolUse(8, ONE), steps, "ONE");
    // The transcript may already hold the second wake when the first is read late.
    const first = [
      ...card,
      ...feed(follower, preInvocation(11), steps),
      ...feed(follower, hook("Stop", { fullyIdle: false }), steps),
    ];
    assert.deepEqual(summarize(first), [
      ["tool_call_update", "call_1", "completed"],
      ["agent_message_chunk", "ONE finished.", null],
    ]);
    assert.deepEqual(follower.pendingToolCallIds(), ["call_2"]);

    const secondCard = feed(follower, postToolUse(9, TWO), steps, "TWO");
    const last = [
      ...secondCard,
      ...feed(follower, preInvocation(13), steps),
      ...feed(follower, hook("Stop", { fullyIdle: true }), steps),
    ];
    assert.deepEqual(summarize(last), [
      ["tool_call_update", "call_2", "completed"],
      ["agent_message_chunk", "TWO finished.", null],
    ]);
  });

  it("matches the finished task by the tool call id agy now names", () => {
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
      toolCallId: "call_2",
      name: "run_command",
      rawInput: ONE,
      status: "open",
    });
    follower.hook(hook("Stop", { fullyIdle: false }));
    follower.promptReturned();
    follower.hook(postToolUse(9, ONE, "run_command", "call_2"));
    assert.deepEqual(follower.pendingToolCallIds(), ["call_1"]);
  });

  it("does not replay a delivered wake into the next prompt", () => {
    const follower = afterFirstWake();
    const steps = transcript(priorWake, second);
    feed(follower, postToolUse(8, ONE), steps, "ONE");
    feed(follower, preInvocation(11), steps);
    feed(follower, hook("Stop", { fullyIdle: false }), steps);

    // agy streams the wake it already reported once the next prompt starts.
    follower.promptStarted();
    const replayedCard = {
      sessionUpdate: "tool_call_update",
      toolCallId: "call_1",
      status: "completed",
    } as const;
    assert.isTrue(follower.isReplay(replayedCard));
    assert.isTrue(follower.isReplay(chunk("ONE fin")));
    assert.isTrue(follower.isReplay(chunk("ished.")));
    assert.isFalse(follower.isReplay(chunk("ONE finished.")));
    assert.isFalse(follower.isReplay({ ...replayedCard, toolCallId: "call_2" }));
    assert.isFalse(follower.isReplay(chunk("a fresh answer")));
  });

  // The wake started this command under an id of ours; agy replays it under its own `call_` id.
  it("recognises a replayed tool by its command when agy names no id in its hooks", () => {
    const follower = launched({ id: "call_1", args: ONE });
    const THREE = { CommandLine: "sleep 9", IsDaemon: false };
    const decided = {
      step_index: 6,
      type: "PLANNER_RESPONSE",
      status: "DONE",
      content: "Next.",
      tool_calls: [{ name: "run_command", args: THREE }],
    };
    const launching = {
      step_index: 7,
      type: "GENERIC",
      status: "RUNNING",
      content: `task id: ${ROOT}/task-7`,
    };
    const closing = {
      step_index: 8,
      type: "PLANNER_RESPONSE",
      status: "DONE",
      content: "Waiting.",
    };
    const steps = transcript(launchSteps, [firstWake[0]!, decided, launching, closing]);
    feed(follower, postToolUse(2, ONE), steps, "ONE");
    const streamed = feed(follower, preInvocation(5), steps);
    feed(follower, hook("Stop", { fullyIdle: false }), steps);
    const launchedCard = summarize(streamed).find((update) => update[0] === "tool_call");
    assert.equal(launchedCard?.[1], `agy-${ROOT}-6-0`);

    follower.promptStarted();
    const replay = {
      sessionUpdate: "tool_call",
      toolCallId: "call_1073786428767115049",
      name: "run_command",
      title: THREE.CommandLine,
      rawInput: THREE,
      status: "in_progress",
    } as const;
    assert.isTrue(follower.isReplay(replay));
    assert.isTrue(
      follower.isReplay({ ...replay, sessionUpdate: "tool_call_update", status: "completed" }),
    );
    assert.isTrue(follower.isReplay(chunk("Next.")));
    assert.isTrue(follower.isReplay(chunk("Waiting.")));
    // A command the user's new prompt runs is not a replay, even with the same text.
    assert.isFalse(follower.isReplay({ ...replay, toolCallId: "call_new" }));
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
