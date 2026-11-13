import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  CALL_ID,
  CHILD,
  LAUNCH,
  ROOT,
  invokeStep,
  makeProfile,
  plannerStep,
  wakeMessageStep,
  type StepRow,
} from "./AntigravityChildWork.testkit.ts";
import {
  makeAntigravityWakeTracker,
  readAntigravityWakeSteps,
  type AntigravityWakeStep,
} from "./AntigravityWake.ts";

const userInput = {
  type: 14,
  payload: new Uint8Array(),
  metadata: new Uint8Array(),
} satisfies StepRow;
const launchNote = plannerStep({ text: "I have launched a subagent." });
const wake = wakeMessageStep(CHILD, "README.md has 1 line.");
const answer = plannerStep({ text: "README.md has 1 line." });

// The log of a launched subagent as agy 1.5.1 wrote it: user 0, planner 1, invoke 2, note 3, wake 4, answer 5.
const logOf = (rows: ReadonlyArray<StepRow>, first = 0): ReadonlyArray<AntigravityWakeStep> =>
  rows.map((row, index) => ({
    idx: first + index,
    type: row.type,
    status: row.status ?? 3,
    payload: row.payload,
  }));

const launchedLog = [
  userInput,
  plannerStep({ calls: [{ id: CALL_ID, name: "invoke_subagent", args: "{}" }] }),
  invokeStep({ callId: CALL_ID, launches: [LAUNCH], children: [CHILD] }),
  launchNote,
];

const track = (rows: ReadonlyArray<StepRow>, liveText = "") => {
  const tracker = makeAntigravityWakeTracker();
  tracker.launch(CALL_ID);
  tracker.observeLiveText(liveText);
  return { tracker, outputs: tracker.advance(logOf(rows)) };
};

describe("AntigravityWakeTracker", () => {
  it.each([
    { name: "no report yet", rows: launchedLog, outputs: [], pending: true },
    {
      name: "report and follow-up",
      rows: [...launchedLog, wake, answer],
      outputs: [
        { type: "text", text: "README.md has 1 line." },
        { type: "completed", toolCallId: CALL_ID, result: "README.md has 1 line." },
      ],
      pending: false,
    },
    {
      name: "report without a follow-up yet",
      rows: [...launchedLog, wake],
      outputs: [],
      pending: true,
    },
    {
      name: "follow-up that keeps using tools",
      rows: [
        ...launchedLog,
        wake,
        plannerStep({
          text: "Checking.",
          calls: [{ id: "call_9", name: "read_file", args: "{}" }],
        }),
      ],
      outputs: [{ type: "text", text: "Checking." }],
      pending: true,
    },
    {
      name: "a message from an unrelated sender",
      rows: [...launchedLog, wakeMessageStep("other-child", "hi"), answer],
      outputs: [],
      pending: true,
    },
    {
      name: "a tool step that failed before the report (agy status 7)",
      rows: [
        ...launchedLog.slice(0, 3),
        { type: 132, payload: new Uint8Array(), metadata: new Uint8Array(), status: 7 },
        launchNote,
        wake,
        answer,
      ],
      outputs: [
        { type: "text", text: "README.md has 1 line." },
        { type: "completed", toolCallId: CALL_ID, result: "README.md has 1 line." },
      ],
      pending: false,
    },
    {
      name: "an unfinished follow-up step",
      rows: [...launchedLog, wake, { ...answer, status: 2 }],
      outputs: [],
      pending: true,
    },
  ] as const)("$name", ({ rows, outputs, pending }) => {
    const result = track(rows);
    assert.deepEqual(result.outputs, [...outputs]);
    assert.equal(result.tracker.pending(), pending);
  });

  it("shows text the stream did not already deliver", () => {
    const result = track([...launchedLog, wake, answer], "The count is: README.md has 1 line.");
    assert.deepEqual(result.outputs, [
      { type: "completed", toolCallId: CALL_ID, result: "README.md has 1 line." },
    ]);
  });

  it.each([
    {
      name: "a short reply that repeats the launch note",
      live: "Done.",
      rows: [
        ...launchedLog.slice(0, 3),
        plannerStep({ text: "Done." }),
        wake,
        plannerStep({ text: "Done." }),
      ],
      texts: ["Done."],
    },
    {
      name: "a follow-up the stream carried with other whitespace",
      live: "README.md has\n1   line.",
      rows: [...launchedLog, wake, answer],
      texts: [],
    },
    {
      name: "a follow-up the stream did not carry",
      live: "I have launched a subagent.",
      rows: [...launchedLog, wake, answer],
      texts: ["README.md has 1 line."],
    },
  ] as const)("shows only unseen text for $name", ({ live, rows, texts }) => {
    const { outputs } = track(rows, live);
    assert.deepEqual(
      outputs.flatMap((output) => (output.type === "text" ? [output.text] : [])),
      [...texts],
    );
    assert.equal(outputs.at(-1)?.type, "completed");
  });

  it("completes the wake when the final planner step is too large to read", () => {
    const { tracker, outputs } = track([...launchedLog, wake]);
    assert.deepEqual(outputs, []);
    const oversized = { idx: 5, type: 15, status: 3, payload: null };
    const result = tracker.advance([oversized]);
    assert.equal(result.at(-1)?.type, "completed");
    assert.equal(tracker.pending(), false);
  });

  it("forgets dropped launches and starts a turn clean on reset", () => {
    const { tracker } = track(launchedLog);
    tracker.drop(CALL_ID);
    assert.equal(tracker.pending(), false);
    tracker.launch(CALL_ID);
    tracker.observeLiveText("hello");
    tracker.reset();
    assert.equal(tracker.pending(), false);
    assert.equal(tracker.cursor(), undefined);
  });

  it("carries on from the last finished step", () => {
    const { tracker } = track([...launchedLog, wake]);
    assert.equal(tracker.cursor(), 4);
    assert.deepEqual(tracker.advance(logOf([answer], 5)), [
      { type: "text", text: "README.md has 1 line." },
      { type: "completed", toolCallId: CALL_ID, result: "README.md has 1 line." },
    ]);
  });
});

describe("readAntigravityWakeSteps", () => {
  it.effect("reads the steps after the last user input, then after the cursor", () =>
    Effect.gen(function* () {
      // Steps before the last user input belong to an earlier turn.
      const { profile } = yield* makeProfile({
        steps: [wake, answer, ...launchedLog, wake, answer],
      });
      const first = yield* readAntigravityWakeSteps(profile, ROOT, undefined);
      assert.deepEqual(
        first.map((step) => [step.idx, step.type]),
        [
          [3, 15],
          [4, 132],
          [5, 15],
          [6, 101],
          [7, 15],
        ],
      );
      const rest = yield* readAntigravityWakeSteps(profile, ROOT, 5);
      assert.deepEqual(
        rest.map((step) => step.idx),
        [6, 7],
      );
      assert.deepEqual(yield* readAntigravityWakeSteps(profile, "missing-session", undefined), []);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
