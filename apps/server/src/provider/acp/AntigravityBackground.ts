import type * as EffectAcpSchema from "effect-acp/compat";

import type { AntigravityHookEvent } from "./AntigravityHookEvents.ts";
import { antigravityToolPresentation } from "./AntigravityProtocol.ts";
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

const GOAL_COMPLETE = "<!-- GOAL_COMPLETE -->";
const GOAL_COMPLETE_MARKER = /\s*<!--\s*GOAL_COMPLETE\s*-->/g;
const stripAntigravityGoalMarker = (text: string) =>
  text.replace(GOAL_COMPLETE_MARKER, "").trimEnd();

/** The end of `text` that could still grow into the goal marker, with the whitespace before it. */
const goalMarkerPrefixStart = (text: string) => {
  const open = text.lastIndexOf("<");
  if (open < 0 || !GOAL_COMPLETE.startsWith(text.slice(open))) return text.length;
  let start = open;
  while (start > 0 && /\s/.test(text[start - 1]!)) start--;
  return start;
};

type SessionUpdate = EffectAcpSchema.SessionUpdate;

export interface AntigravityBackgroundStep {
  readonly updates: ReadonlyArray<SessionUpdate>;
  /** Files the caller should read now and pass to `ingest`. */
  readonly read?: {
    readonly transcriptPath: string;
    /** Where a finished command's output is already written, before the transcript has it. */
    readonly taskLog?: { readonly toolCallId: string; readonly path: string };
  };
}

export interface AntigravityIngest {
  readonly steps: ReadonlyArray<AntigravityTranscriptStep>;
  readonly taskLog?: { readonly toolCallId: string; readonly text: string };
}

export interface AntigravityToolObservation {
  readonly toolCallId: string;
  readonly name: string;
  readonly rawInput: unknown;
  readonly status: "open" | "settled";
}

type ToolPresentation = ReturnType<typeof antigravityToolPresentation>;

interface TrackedTool {
  toolCallId: string;
  readonly name: string;
  readonly args: unknown;
  readonly presentation: ToolPresentation;
  synthetic: boolean;
  background: boolean;
  done: boolean;
  stepIdx: number | undefined;
  /** False for a call the transcript names before its PreToolUse hook says it began. */
  started: boolean;
  /** What the last completion update carried; a later transcript can correct it. */
  delivered:
    | {
        readonly exitCode: number | undefined;
        readonly output: string | undefined;
        fromMessage: boolean;
      }
    | undefined;
}

/** One stretch of agy working on its own: from a finished task to the `Stop` that ends it. */
interface Wake {
  /** The first transcript step of the wake; known once its PreInvocation arrives. */
  from: number | undefined;
  stopped: boolean;
  cursor: number;
  /** Calls the transcript named, in order, awaiting their result steps. */
  open: TrackedTool[];
  /** PreToolUse hooks not yet matched to a call the transcript named. */
  starts: Array<{
    readonly name: string;
    readonly args: unknown;
    readonly id: string | null | undefined;
  }>;
  /** agy's reply has been seen; whatever follows it in the transcript belongs to a later wake. */
  ended: boolean;
}

interface ShownCall {
  readonly name: string;
  readonly args: unknown;
  matched: boolean;
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

const taskLogPath = (transcriptPath: string, stepIdx: number) => {
  const logs = /^(.*)[\\/]logs[\\/][^\\/]+$/.exec(transcriptPath);
  return logs === null ? undefined : `${logs[1]}/tasks/task-${stepIdx}.log`;
};

const squash = (text: string) => text.replace(/\s+/g, "");

export function makeAntigravityBackgroundFollower() {
  let sessionId: string | undefined;
  let promptInFlight = false;
  let busyStopDuringPrompt = false;
  let wake: Wake | undefined;
  let transcriptPath: string | undefined;
  /** Tool calls delivered by a wake; agy streams them again at the next prompt. */
  const reported = new Set<string>();
  /** Calls shown under an id of ours, which the replay names with agy's own. */
  let shownCalls: ShownCall[] = [];
  const replayedIds = new Set<string>();
  let shownTexts: string[] = [];
  let replayMatch: string | undefined;
  /** The replay comes first at a prompt; anything else it streams is the prompt's own. */
  let replayOpen = false;
  /** The end of a live reply that may be the start of the goal marker, held until it is known. */
  let heldText = "";
  /** The tail of the live text shown since the last tool call, for the break before agy's next response. */
  let liveTail: string | undefined;
  let invocationBegan = false;
  let pendingCompletions: Array<{
    readonly tool: TrackedTool;
    readonly error: string | null | undefined;
  }> = [];
  const taskOutputs = new Map<string, string>();
  const tools = new Map<string, TrackedTool>();
  const knownMessages = new Map<
    number,
    NonNullable<ReturnType<typeof parseAntigravityTaskMessage>>
  >();

  const tag = (): { readonly _meta?: Record<string, unknown> } =>
    promptInFlight ? {} : { _meta: { [ANTIGRAVITY_WAKE_META]: true } };

  const toolUpdate = (
    tool: Pick<TrackedTool, "toolCallId" | "name" | "args" | "presentation">,
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
      ...tool.presentation,
      rawInput: tool.args,
      ...fields,
      ...tag(),
    }) as SessionUpdate;

  const outputFor = (tool: TrackedTool, error: string | null | undefined) => {
    const message = tool.stepIdx === undefined ? undefined : knownMessages.get(tool.stepIdx);
    const failed =
      (error !== undefined && error !== null && error.length > 0) || (message?.exitCode ?? 0) !== 0;
    // A command that ended without an error succeeded, until its wake message says otherwise.
    const exitCode = message?.exitCode ?? (failed ? undefined : 0);
    if (tool.name === "run_command") {
      const output =
        message?.output ?? taskOutputs.get(tool.toolCallId) ?? (error ? error : undefined);
      return {
        failed,
        message,
        exitCode,
        output,
        rawOutput:
          output === undefined && exitCode === undefined
            ? undefined
            : {
                ...(output === undefined ? {} : { combinedOutput: output }),
                ...(exitCode === undefined ? {} : { exitCode }),
              },
      };
    }
    return {
      failed,
      message,
      exitCode: undefined,
      output: undefined,
      rawOutput: failed && error ? error : "Timer elapsed.",
    };
  };

  const complete = (tool: TrackedTool, error: string | null | undefined): SessionUpdate => {
    const { failed, message, exitCode, output, rawOutput } = outputFor(tool, error);
    tool.delivered = { exitCode, output, fromMessage: message !== undefined };
    reported.add(tool.toolCallId);
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
    readonly started: boolean;
    readonly synthetic?: boolean;
  }) => {
    const tool: TrackedTool = {
      toolCallId: input.toolCallId,
      name: input.name,
      args: input.args,
      presentation: antigravityToolPresentation(input.name, input.args),
      background: input.background,
      done: false,
      stepIdx: undefined,
      started: input.started,
      synthetic: input.synthetic === true,
      delivered: undefined,
    };
    tools.set(input.toolCallId, tool);
    return tool;
  };

  const startTool = (tool: TrackedTool): SessionUpdate[] => {
    if (tool.started) return [];
    tool.started = true;
    reported.add(tool.toolCallId);
    if (tool.synthetic) shownCalls.push({ name: tool.name, args: tool.args, matched: false });
    return [toolUpdate(tool, { status: "in_progress" }, "tool_call")];
  };

  const newWake = (): Wake => ({
    from: undefined,
    stopped: false,
    cursor: -1,
    open: [],
    starts: [],
    ended: false,
  });

  /** Ends the wake: calls still without a result step have nothing more to report. */
  const closeWake = (): SessionUpdate[] => {
    const updates: SessionUpdate[] = [];
    const current = wake;
    wake = undefined;
    const completions = pendingCompletions;
    pendingCompletions = [];
    for (const { tool, error } of completions) updates.push(complete(tool, error));
    if (current === undefined) return updates;
    for (const tool of current.open) {
      updates.push(...startTool(tool));
      tool.done = true;
      updates.push(toolUpdate(tool, { status: "completed" }, "tool_call_update"));
    }
    return updates;
  };

  /** A later transcript read can know more than the completion that was already sent. */
  const corrections = (): SessionUpdate[] => {
    const updates: SessionUpdate[] = [];
    for (const tool of tools.values()) {
      if (!tool.done || tool.delivered === undefined || tool.delivered.fromMessage) continue;
      const message = tool.stepIdx === undefined ? undefined : knownMessages.get(tool.stepIdx);
      if (message === undefined) continue;
      if (
        (message.exitCode === undefined || message.exitCode === tool.delivered.exitCode) &&
        (message.output === undefined || message.output === tool.delivered.output)
      ) {
        tool.delivered.fromMessage = true;
        continue;
      }
      updates.push(complete(tool, undefined));
    }
    return updates;
  };

  const takeStart = (name: string, args: unknown) => {
    if (wake === undefined) return undefined;
    const canonicalArgs = canonical(args ?? null);
    const index = wake.starts.findIndex(
      (start) => start.name === name && canonical(start.args ?? null) === canonicalArgs,
    );
    if (index < 0) return undefined;
    const [start] = wake.starts.splice(index, 1);
    return { id: start?.id ?? undefined };
  };

  const announce = (
    step: AntigravityTranscriptStep,
    call: NonNullable<AntigravityTranscriptStep["tool_calls"]>[number],
    index: number,
  ): SessionUpdate[] => {
    const begun = takeStart(call.name, call.args);
    const realId = begun?.id ?? call.id ?? undefined;
    const tool = track({
      toolCallId: realId ?? `agy-${sessionId ?? "session"}-${step.step_index}-${index}`,
      name: call.name,
      args: call.args,
      background: false,
      started: false,
      synthetic: realId === undefined,
    });
    wake!.open.push(tool);
    // The hook says the tool begins now; without it the call starts when its result arrives.
    return begun === undefined && call.id == null ? [] : startTool(tool);
  };

  const flushStarts = (): SessionUpdate[] => {
    const updates: SessionUpdate[] = [];
    if (wake === undefined) return updates;
    for (const tool of wake.open) {
      if (tool.started) continue;
      const begun = takeStart(tool.name, tool.args);
      if (begun === undefined) continue;
      // The hook can name the call after the transcript did, as long as nothing was shown yet.
      if (begun.id !== undefined) {
        tools.delete(tool.toolCallId);
        tool.toolCallId = begun.id;
        tool.synthetic = false;
        tools.set(tool.toolCallId, tool);
      }
      updates.push(...startTool(tool));
    }
    return updates;
  };

  const stream = (steps: ReadonlyArray<AntigravityTranscriptStep>): SessionUpdate[] => {
    const current = wake;
    if (current === undefined || current.from === undefined || current.ended) return [];
    const updates: SessionUpdate[] = [];
    const pending = steps
      .filter((step) => step.step_index >= current.from! && step.step_index > current.cursor)
      .toSorted((a, b) => a.step_index - b.step_index);
    const emitText = (raw: string | undefined) => {
      const text = stripAntigravityGoalMarker(raw ?? "");
      if (text.trim().length === 0) return;
      shownTexts.push(squash(text));
      updates.push({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
        ...tag(),
      } as SessionUpdate);
    };
    for (const [position, step] of pending.entries()) {
      if (step.type === "PLANNER_RESPONSE") {
        const calls = step.tool_calls ?? [];
        if (calls.length === 0) {
          const next = pending[position + 1];
          // The last text may still be a reply agy rejects, so it waits for what follows it.
          if (next === undefined && !current.stopped) break;
          if (next?.type !== "ERROR_MESSAGE") {
            emitText(step.content);
            current.cursor = step.step_index;
            current.ended = true;
            break;
          }
        } else {
          emitText(step.content);
          for (const [index, call] of calls.entries()) updates.push(...announce(step, call, index));
        }
      } else if (step.type === "GENERIC") {
        const tool = current.open.shift();
        if (tool !== undefined) {
          updates.push(...startTool(tool));
          if (step.status === "RUNNING" && isAntigravityBackgroundToolName(tool.name)) {
            tool.background = true;
            tool.stepIdx = step.step_index;
          } else {
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
      }
      current.cursor = step.step_index;
    }
    updates.push(...flushStarts());
    return updates;
  };

  const replayedCall = (update: SessionUpdate & { readonly toolCallId: string }) => {
    const fields = update as { readonly name?: unknown; readonly rawInput?: unknown };
    if (fields.rawInput === undefined) return false;
    const args = canonical(fields.rawInput);
    const command = asRecord(fields.rawInput).CommandLine;
    const shown = shownCalls.find(
      (call) =>
        !call.matched &&
        (fields.name === undefined || fields.name === call.name) &&
        (canonical(call.args ?? null) === args ||
          (typeof command === "string" && asRecord(call.args).CommandLine === command)),
    );
    if (shown === undefined) return false;
    shown.matched = true;
    replayedIds.add(update.toolCallId);
    return true;
  };

  return {
    sessionStarted(id: string) {
      sessionId = id;
      tools.clear();
      wake = undefined;
      pendingCompletions = [];
      reported.clear();
      replayedIds.clear();
      shownCalls = [];
      shownTexts = [];
      replayMatch = undefined;
      replayOpen = false;
      heldText = "";
      liveTail = undefined;
      invocationBegan = false;
      taskOutputs.clear();
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
          started: true,
        });
      }
    },

    promptStarted() {
      promptInFlight = true;
      busyStopDuringPrompt = false;
      wake = undefined;
      heldText = "";
      liveTail = undefined;
      invocationBegan = false;
      replayMatch = undefined;
      replayOpen = shownTexts.length > 0 || shownCalls.some((call) => !call.matched);
    },

    /** agy's own re-stream of a wake already delivered: its tool calls by id or command, its text in order. */
    isReplay(update: SessionUpdate): boolean {
      if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
        if (reported.has(update.toolCallId) || replayedIds.has(update.toolCallId)) return true;
        return promptInFlight && replayOpen && replayedCall(update);
      }
      if (update.sessionUpdate !== "agent_message_chunk" || update.content.type !== "text") {
        return false;
      }
      if (!promptInFlight || !replayOpen) return false;
      const chunk = squash(update.content.text);
      if (chunk.length === 0) return replayMatch !== undefined;
      if (replayMatch !== undefined && replayMatch.startsWith(chunk)) {
        replayMatch = replayMatch.slice(chunk.length);
        if (replayMatch.length === 0) replayMatch = undefined;
        return true;
      }
      const index = shownTexts.findIndex((text) => text.startsWith(chunk));
      if (index >= 0) {
        const [text] = shownTexts.splice(index, 1);
        const rest = text!.slice(chunk.length);
        replayMatch = rest.length === 0 ? undefined : rest;
        return true;
      }
      replayOpen = false;
      replayMatch = undefined;
      return false;
    },

    /**
     * What the prompt streams, ready to show: a wake T3 Code already showed is dropped, the goal
     * marker is cut, and a new response of agy's is set apart from the one before it.
     */
    incoming(update: SessionUpdate): ReadonlyArray<SessionUpdate> {
      if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
        const joined = (heldText + update.content.text).replace(GOAL_COMPLETE_MARKER, "");
        const start = goalMarkerPrefixStart(joined);
        heldText = joined.slice(start);
        const text = joined.slice(0, start);
        if (text.length === 0) return [];
        if (this.isReplay({ ...update, content: { ...update.content, text } })) return [];
        const newlines =
          (/\n*$/.exec(liveTail ?? "")?.[0].length ?? 0) + (/^\n*/.exec(text)?.[0].length ?? 0);
        const gap =
          invocationBegan && liveTail !== undefined && liveTail.length > 0
            ? "\n".repeat(Math.max(0, 2 - newlines))
            : "";
        invocationBegan = false;
        liveTail = `${gap}${text}`.slice(-2);
        return [{ ...update, content: { ...update.content, text: `${gap}${text}` } }];
      }
      const flushed = this.flush();
      if (this.isReplay(update)) return flushed;
      if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
        liveTail = undefined;
      }
      return [...flushed, update];
    },

    /** Text that only looked like the start of the goal marker. */
    flush(): ReadonlyArray<SessionUpdate> {
      if (heldText.length === 0) return [];
      const text = heldText;
      heldText = "";
      liveTail = text.slice(-2);
      return [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text } }];
    },

    promptReturned() {
      shownTexts = [];
      shownCalls = [];
      replayMatch = undefined;
      replayOpen = false;
      promptInFlight = false;
      if (busyStopDuringPrompt) confirmBackground();
      busyStopDuringPrompt = false;
    },

    /** Stop or a failed prompt: nothing agy does afterwards belongs to a run T3 Code is showing. */
    abandon(): ReadonlyArray<SessionUpdate> {
      const updates = this.failUnconfirmed("The command was interrupted.");
      promptInFlight = false;
      busyStopDuringPrompt = false;
      wake = undefined;
      pendingCompletions = [];
      tools.clear();
      return updates;
    },

    /** A prompt that did not end normally: commands still open were never backgrounded, so they end with it. */
    failUnconfirmed(reason: string): ReadonlyArray<SessionUpdate> {
      const updates: SessionUpdate[] = [];
      for (const tool of tools.values()) {
        if (tool.done || tool.background) continue;
        tool.done = true;
        reported.add(tool.toolCallId);
        updates.push(toolUpdate(tool, { status: "failed", rawOutput: reason }, "tool_call_update"));
      }
      return updates;
    },

    /** The runtime is going away: during a prompt, every task it was tracking is lost with it. */
    lost(): ReadonlyArray<SessionUpdate> {
      if (!promptInFlight) return [];
      const updates: SessionUpdate[] = [];
      for (const tool of tools.values()) {
        if (tool.done) continue;
        tool.done = true;
        updates.push(
          toolUpdate(
            tool,
            { status: "failed", rawOutput: "agy stopped before this task reported." },
            "tool_call_update",
          ),
        );
      }
      return updates;
    },

    /** The first transcript step a read for the current hook needs. */
    readFrom(): number {
      const wanted = [
        wake?.from,
        ...pendingCompletions.map(({ tool }) => tool.stepIdx),
        ...[...tools.values()].map((tool) =>
          tool.delivered?.fromMessage === false ? tool.stepIdx : undefined,
        ),
      ].filter((index) => index !== undefined);
      return wanted.length === 0 ? 0 : Math.min(...wanted);
    },

    /** agy is still working on a wake T3 Code is showing, so its run must stay open. */
    wakeInProgress(): boolean {
      return wake !== undefined && !promptInFlight;
    },

    /** The wake has stopped but the follow-up's last step is not in the transcript yet. */
    awaitingFinal(): boolean {
      return wake !== undefined && wake.stopped;
    },

    /** Gives up on a wake that will not finish: nothing may hold its run open for ever. */
    endWake(): ReadonlyArray<SessionUpdate> {
      return closeWake();
    },

    pendingToolCallIds(): ReadonlyArray<string> {
      return [...tools.values()]
        .filter((tool) => tool.background && !tool.done)
        .map((t) => t.toolCallId);
    },

    hook(event: AntigravityHookEvent): AntigravityBackgroundStep {
      if (sessionId === undefined || event.conversationId !== sessionId) return { updates: [] };
      if (event.transcriptPath !== undefined) transcriptPath = event.transcriptPath;
      const read = transcriptPath === undefined ? undefined : { transcriptPath };
      const inWake = wake !== undefined && !promptInFlight;
      switch (event.name) {
        case "PostToolUse": {
          const call = event.toolCall;
          const open =
            call === undefined
              ? []
              : [...tools.values()].filter(
                  (candidate) =>
                    candidate.background && !candidate.done && candidate.name === call.name,
                );
          const args = canonical(call?.args ?? null);
          // agy 1.5.x names the tool call in its hook; older runs are matched by their arguments.
          const tool =
            call === undefined
              ? undefined
              : (open.find((candidate) => candidate.toolCallId === call.id) ??
                open.find((candidate) => canonical(candidate.args ?? null) === args));
          if (tool === undefined)
            return inWake && read !== undefined ? { updates: [], read } : { updates: [] };
          tool.done = true;
          tool.stepIdx = event.stepIdx;
          pendingCompletions.push({ tool, error: event.error });
          if (!promptInFlight && wake === undefined) wake = newWake();
          const path =
            transcriptPath === undefined || event.stepIdx === undefined
              ? undefined
              : taskLogPath(transcriptPath, event.stepIdx);
          if (read === undefined) return { updates: closeWake() };
          return {
            updates: [],
            read: {
              ...read,
              ...(path === undefined ? {} : { taskLog: { toolCallId: tool.toolCallId, path } }),
            },
          };
        }
        case "PreInvocation": {
          invocationBegan = true;
          if (promptInFlight) return { updates: [] };
          if (wake === undefined) {
            // Not caused by a finished tool: a timer fired. Each such invocation starts at 0.
            if (event.invocationNum !== 0) return { updates: [] };
            wake = newWake();
            wake.from = event.initialNumSteps ?? 0;
            return read === undefined ? { updates: [] } : { updates: [], read };
          }
          if (wake.stopped) {
            // The next wake begins before the last one's follow-up was ever read.
            const updates = closeWake();
            wake = newWake();
            wake.from = event.initialNumSteps ?? 0;
            return { updates, ...(read === undefined ? {} : { read }) };
          }
          if (wake.from === undefined) wake.from = event.initialNumSteps ?? 0;
          return read === undefined ? { updates: [] } : { updates: [], read };
        }
        case "PreToolUse": {
          if (!inWake || wake === undefined || event.toolCall === undefined) return { updates: [] };
          wake.starts.push({
            name: event.toolCall.name,
            args: event.toolCall.args,
            id: event.toolCall.id,
          });
          return read === undefined ? { updates: [] } : { updates: [], read };
        }
        case "Stop": {
          if (
            inWake &&
            wake !== undefined &&
            (wake.from !== undefined || event.fullyIdle === true)
          ) {
            if (wake.from === undefined) return { updates: closeWake() };
            wake.stopped = true;
            return read === undefined ? { updates: closeWake() } : { updates: [], read };
          }
          if (promptInFlight) {
            if (event.fullyIdle === false) busyStopDuringPrompt = true;
          } else if (event.fullyIdle === false) {
            confirmBackground();
          }
          return { updates: [] };
        }
      }
    },

    /** Everything read for a hook: new transcript steps and, for a finished command, its log. */
    ingest(input: AntigravityIngest): ReadonlyArray<SessionUpdate> {
      for (const step of input.steps) {
        if (step.type !== "SYSTEM_MESSAGE") continue;
        const message = parseAntigravityTaskMessage(step.content);
        if (message !== undefined) knownMessages.set(message.stepIdx, message);
      }
      if (input.taskLog !== undefined) {
        const text = input.taskLog.text.replaceAll("\r\n", "\n").trimEnd();
        if (text.length > 0) taskOutputs.set(input.taskLog.toolCallId, text);
      }
      const updates: SessionUpdate[] = [];
      const completions = pendingCompletions;
      pendingCompletions = [];
      for (const { tool, error } of completions) updates.push(complete(tool, error));
      updates.push(...corrections());
      updates.push(...stream(input.steps));
      if (wake?.stopped === true && wake.ended) updates.push(...closeWake());
      return updates;
    },
  };
}

export type AntigravityBackgroundFollower = ReturnType<typeof makeAntigravityBackgroundFollower>;
