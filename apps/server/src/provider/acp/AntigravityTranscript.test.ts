import { assert, describe, it } from "@effect/vitest";

import { parseAntigravityTranscript } from "./AntigravityTranscript.ts";

const line = (step: object) => JSON.stringify(step);

describe("parseAntigravityTranscript", () => {
  const steps = [
    { step_index: 4, type: "PLANNER_RESPONSE", status: "DONE", content: "started" },
    { step_index: 5, type: "SYSTEM_MESSAGE", status: "DONE", content: "finished" },
    {
      step_index: 6,
      type: "PLANNER_RESPONSE",
      status: "DONE",
      content: "done",
      tool_calls: [{ name: "run_command", args: { CommandLine: "ls" } }],
      input_tokens: 10,
    },
  ];

  it("returns the steps from an index on and drops fields it does not read", () => {
    const text = `${steps.map(line).join("\n")}\n`;
    assert.deepEqual(
      parseAntigravityTranscript(text, 5).map((step) => step.step_index),
      [5, 6],
    );
    assert.deepEqual(parseAntigravityTranscript(text, 6)[0], {
      step_index: 6,
      type: "PLANNER_RESPONSE",
      status: "DONE",
      content: "done",
      tool_calls: [{ name: "run_command", args: { CommandLine: "ls" } }],
    });
  });

  it("skips a line still being written and the cut line at the start of a tail", () => {
    const text = `{"step_index":3,"ty\n${steps.map(line).join("\n")}\n{"step_index":7,"type":"PLANNER_RES`;
    assert.deepEqual(
      parseAntigravityTranscript(text, 0, { truncatedStart: true }).map((step) => step.step_index),
      [4, 5, 6],
    );
  });
});
