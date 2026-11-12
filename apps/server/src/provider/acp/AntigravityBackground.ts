import type * as EffectAcpSchema from "effect-acp/compat";

import type { AntigravityHookEvent } from "./AntigravityHookEvents.ts";
import type { AntigravityTranscriptStep } from "./AntigravityTranscript.ts";

/**
 * agy sends nothing over ACP when a background command or timer ends, nor for the model's
 * follow-up that wakes afterwards. Its hooks say when each happens and its transcript holds the
 * content. This follows both and produces the `session/update`s the protocol would have carried.
 * Subagent wakes are not handled here: they have no PostToolUse of a background task before them.
 */

/** Marks updates for agy's own follow-up work, which no prompt of ours is waiting on. */
export const ANTIGRAVITY_WAKE_META = "t3AgyWake";

const BACKGROUND_TOOLS: ReadonlySet<string> = new Set(["run_command", "schedule"]);
export const isAntigravityBackgroundToolName = (name: unknown): name is string =>
  typeof name === "string" && BACKGROUND_TOOLS.has(name);

const GOAL_COMPLETE_MARKER = /\s*<!--\s*GOAL_COMPLETE\s*-->\s*$/;
const stripAntigravityGoalMarker = (text: string) => text.replace(GOAL_COMPLETE_MARKER, "");

type SessionUpdate = EffectAcpSchema.SessionUpdate;

export interface AntigravityBackgroundStep {
  readonly updates: ReadonlyArray<SessionUpdate>;
  /** Steps the caller should read from this transcript and pass to `transcript`. */
  readonly read?: { readonly transcriptPath: string };
}

export interface AntigravityToolObservation {
  readonly toolCallId: string;
  readonly name: string;
  readonly rawInput: unknown;
  readonly status: "open" | "settled";
}

interface TrackedTool {
  readonly toolCallId: string;
  readonly name: string;
  readonly args: unknown;
  readonly title: string;
  readonly kind: "execute" | "other";
  background: boolean;
  done: boolean;
  stepIdx: number | undefined;
  /** The completion carried no output yet; a later transcript read can supply it. */
  needsOutput: boolean;
  failed: boolean;
}

interface Wake {
  readonly from: number;
  stopped: boolean;
  fullyIdle: boolean;
}

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, nested: unknown) =>
    nested !== null && typeof nested === "object" && !Array.isArray(nested)
      ? Object.fromEntries(
          Object.entries(nested as Record<string, unknown>).toSorted(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : nested,
  );

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

const toolDescription = (name: string, args: unknown) => {
  const commandLine = asRecord(args).CommandLine;
  return typeof commandLine === "string" && commandLine.trim().length > 0
    ? ({ title: commandLine.trim(), kind: "execute" } as const)
    : ({ title: `Run ${name}`, kind: "other" } as const);
};

const TASK_SENDER = /\bsender=\S*?\/task-(\d+)\b/;
const EXIT_CODE = /Command exited with code (-?\d+)\./;

/** The finished-task message agy writes into its transcript when a background task ends. */
export function parseAntigravityTaskMessage(content: string | undefined) {
  if (content === undefined) return undefined;
  const task = TASK_SENDER.exec(content);
  if (task === null) return undefined;
  const result = content.split(/finished with result:\r?\n/)[1];
  if (result === undefined)
    return { stepIdx: Number(task[1]), output: undefined, exitCode: undefined };
  const body = result.split(/\nLog: file:|\n<\/SYSTEM_MESSAGE>/)[0] ?? result;
  const exit = EXIT_CODE.exec(body);
  const output = body
    .split(/Command output:\r?\n/)[1]
    ?.replaceAll("\r\n", "\n")
    .trimEnd();
  return {
    stepIdx: Number(task[1]),
    output: output === undefined || output.length === 0 ? undefined : output,
    exitCode: exit === null ? undefined : Number(exit[1]),
  };
}

export function makeAntigravityBackgroundFollower() {
  let sessionId: string | undefined;
  let promptInFlight = false;
  let busyStopDuringPrompt = false;
  let pendingWakes = 0;
  let wake: Wake | undefined;
  let cursor = -1;
  let transcriptPath: string | undefined;
  const tools = new Map<string, TrackedTool>();
  const knownMessages = new Map<
    number,
    NonNullable<ReturnType<typeof parseAntigravityTaskMessage>>
  >();

  const tag = (): { readonly _meta?: Record<string, unknown> } =>
    promptInFlight ? {} : { _meta: { [ANTIGRAVITY_WAKE_META]: true } };

  const toolUpdate = (
    tool: Pick<TrackedTool, "toolCallId" | "name" | "args" | "title" | "kind">,
    fields: {
      readonly status: "in_progress" | "completed" | "failed";
      readonly rawOutput?: unknown;
    },
    sessionUpdate: "tool_call" | "tool_call_update",
  ): SessionUpdate =>
    ({
      sessionUpdate,
      toolCallId: tool.toolCallId,
      name: tool.name,
      title: tool.title,
      kind: tool.kind,
      rawInput: tool.args,
      ...fields,
      ...tag(),
    }) as SessionUpdate;

  const outputFor = (tool: TrackedTool, error: string | null | undefined) => {
    const message = tool.stepIdx === undefined ? undefined : knownMessages.get(tool.stepIdx);
    const exitCode = message?.exitCode;
    const failed =
      (error !== undefined && error !== null && error.length > 0) || (exitCode ?? 0) !== 0;
    if (tool.name === "run_command") {
      const output = message?.output ?? (error ? error : undefined);
      return {
        failed,
        known: message !== undefined,
        rawOutput:
          output === undefined && exitCode === undefined
            ? undefined
            : {
                ...(output === undefined ? {} : { combinedOutput: output }),
                ...(exitCode === undefined ? {} : { exitCode }),
              },
      };
    }
    return { failed, known: true, rawOutput: failed && error ? error : "Timer elapsed." };
  };

  const complete = (tool: TrackedTool, error: string | null | undefined): SessionUpdate => {
    const { failed, known, rawOutput } = outputFor(tool, error);
    tool.needsOutput = !known;
    tool.failed = failed;
    return toolUpdate(
      tool,
      {
        status: failed ? "failed" : "completed",
        ...(rawOutput === undefined ? {} : { rawOutput }),
      },
      "tool_call_update",
    );
  };

  const confirmBackground = () => {
    for (const tool of tools.values()) {
      if (!tool.done) tool.background = true;
    }
  };

  const track = (input: {
    readonly toolCallId: string;
    readonly name: string;
    readonly args: unknown;
    readonly background: boolean;
    readonly stepIdx?: number;
    readonly title?: string;
  }) => {
    const description = toolDescription(input.name, input.args);
    tools.set(input.toolCallId, {
      toolCallId: input.toolCallId,
      name: input.name,
      args: input.args,
      title: input.title ?? description.title,
      kind: description.kind,
      background: input.background,
      done: false,
      stepIdx: input.stepIdx,
      needsOutput: false,
      failed: false,
    });
  };

  /** Updates for outputs a transcript now knows for tasks completed without them. */
  const fillOutputs = (): SessionUpdate[] => {
    const updates: SessionUpdate[] = [];
    for (const tool of tools.values()) {
      if (!tool.done || !tool.needsOutput || tool.stepIdx === undefined) continue;
      if (!knownMessages.has(tool.stepIdx)) continue;
      updates.push(complete(tool, undefined));
    }
    return updates;
  };

  const followUp = (steps: ReadonlyArray<AntigravityTranscriptStep>, from: number) => {
    const updates: SessionUpdate[] = [];
    const calls: TrackedTool[] = [];
    for (const step of steps) {
      if (step.step_index < from || step.step_index <= cursor) continue;
      if (step.type === "PLANNER_RESPONSE") {
        const text = stripAntigravityGoalMarker(step.content ?? "");
        if (text.trim().length > 0) {
          updates.push({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text },
            ...tag(),
          } as SessionUpdate);
        }
        for (const [index, call] of (step.tool_calls ?? []).entries()) {
          const id = `agy-${sessionId ?? "session"}-${step.step_index}-${index}`;
          track({ toolCallId: id, name: call.name, args: call.args, background: false });
          const tool = tools.get(id)!;
          calls.push(tool);
          updates.push(toolUpdate(tool, { status: "in_progress" }, "tool_call"));
        }
      } else if (step.type === "GENERIC") {
        const tool = calls.shift();
        if (tool === undefined) continue;
        if (step.status === "RUNNING" && isAntigravityBackgroundToolName(tool.name)) {
          tool.background = true;
          tool.stepIdx = step.step_index;
          continue;
        }
        tool.done = true;
        updates.push(
          toolUpdate(
            tool,
            {
              status: "completed",
              ...(step.content === undefined ? {} : { rawOutput: step.content }),
            },
            "tool_call_update",
          ),
        );
      }
    }
    // Tools whose result step is missing have nothing more to report; none may spin forever.
    for (const tool of calls) {
      tool.done = true;
      updates.push(toolUpdate(tool, { status: "completed" }, "tool_call_update"));
    }
    for (const step of steps) cursor = Math.max(cursor, step.step_index);
    return updates;
  };

  return {
    sessionStarted(id: string) {
      sessionId = id;
      tools.clear();
      wake = undefined;
      pendingWakes = 0;
      cursor = -1;
      knownMessages.clear();
    },

    /** Called for each root-session `tool_call` and `tool_call_update` agy sends. */
    toolObserved(input: AntigravityToolObservation) {
      if (!isAntigravityBackgroundToolName(input.name)) return;
      if (input.status === "settled") {
        const tool = tools.get(input.toolCallId);
        if (tool !== undefined) tool.done = true;
        return;
      }
      if (!tools.has(input.toolCallId)) {
        track({
          toolCallId: input.toolCallId,
          name: input.name,
          args: input.rawInput,
          background: false,
        });
      }
    },

    promptStarted() {
      promptInFlight = true;
      busyStopDuringPrompt = false;
      wake = undefined;
      pendingWakes = 0;
    },

    promptReturned() {
      promptInFlight = false;
      if (busyStopDuringPrompt) confirmBackground();
      busyStopDuringPrompt = false;
    },

    /** Stop or a failed prompt: nothing agy does afterwards belongs to a run T3 Code is showing. */
    abandon() {
      promptInFlight = false;
      busyStopDuringPrompt = false;
      wake = undefined;
      pendingWakes = 0;
      tools.clear();
    },

    pendingToolCallIds(): ReadonlyArray<string> {
      return [...tools.values()]
        .filter((tool) => tool.background && !tool.done)
        .map((t) => t.toolCallId);
    },

    hook(event: AntigravityHookEvent): AntigravityBackgroundStep {
      if (sessionId === undefined || event.conversationId !== sessionId) return { updates: [] };
      if (event.transcriptPath !== undefined) transcriptPath = event.transcriptPath;
      const read = transcriptPath === undefined ? {} : { read: { transcriptPath } };
      switch (event.name) {
        case "PostToolUse": {
          if (event.toolCall === undefined) return { updates: [] };
          const args = canonical(event.toolCall.args ?? null);
          const tool = [...tools.values()].find(
            (candidate) =>
              candidate.background &&
              !candidate.done &&
              candidate.name === event.toolCall!.name &&
              canonical(candidate.args ?? null) === args,
          );
          if (tool === undefined) return { updates: [] };
          tool.done = true;
          tool.stepIdx = event.stepIdx;
          if (!promptInFlight) pendingWakes += 1;
          return { updates: [complete(tool, event.error)], ...read };
        }
        case "PreInvocation": {
          if (!promptInFlight && wake === undefined && pendingWakes > 0) {
            pendingWakes = 0;
            wake = { from: event.initialNumSteps ?? 0, stopped: false, fullyIdle: false };
          }
          return { updates: [] };
        }
        case "Stop": {
          if (wake !== undefined) {
            wake.stopped = true;
            wake.fullyIdle = event.fullyIdle === true;
            return { updates: [], ...read };
          }
          if (event.fullyIdle === true) pendingWakes = 0;
          if (promptInFlight) {
            if (event.fullyIdle === false) busyStopDuringPrompt = true;
          } else if (event.fullyIdle === false) {
            confirmBackground();
          }
          return { updates: [] };
        }
      }
    },

    /**
     * Steps read from the transcript. `incomplete` means a wake has stopped but its follow-up is
     * not written yet; the next hook or a later read completes it.
     */
    transcript(steps: ReadonlyArray<AntigravityTranscriptStep>): {
      readonly updates: ReadonlyArray<SessionUpdate>;
      readonly incomplete: boolean;
    } {
      for (const step of steps) {
        if (step.type !== "SYSTEM_MESSAGE") continue;
        const message = parseAntigravityTaskMessage(step.content);
        if (message !== undefined) knownMessages.set(message.stepIdx, message);
      }
      const updates = fillOutputs();
      if (wake === undefined || !wake.stopped) return { updates, incomplete: false };
      const fresh = steps.filter((step) => step.step_index >= wake!.from);
      const triggered = fresh.findIndex((step) => step.type === "SYSTEM_MESSAGE");
      const answered = fresh
        .slice(Math.max(0, triggered))
        .some((step) => step.type === "PLANNER_RESPONSE");
      if (!answered) return { updates, incomplete: true };
      const { from, fullyIdle } = wake;
      wake = undefined;
      if (fullyIdle) pendingWakes = 0;
      return { updates: [...updates, ...followUp(fresh, from)], incomplete: false };
    },
  };
}

export type AntigravityBackgroundFollower = ReturnType<typeof makeAntigravityBackgroundFollower>;
