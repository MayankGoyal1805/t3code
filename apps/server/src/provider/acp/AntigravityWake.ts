import * as Effect from "effect/Effect";

import { ANTIGRAVITY_CONVERSATION_SEGMENTS, decodeInvokeRecord } from "./AntigravityChildWork.ts";
import { message, messages, text } from "./AntigravityProto.ts";
import { antigravityManagedPath, antigravityProfileRoot } from "./AntigravityProfilePaths.ts";
import { readSteps } from "./AntigravityTurnOutcome.ts";

/**
 * `agy acp` streams nothing after a subagent reports back: the parent's follow-up run only
 * reaches its session log. This reads that log (read-only, this session's own database) and
 * turns the follow-up into the updates the stream would have carried.
 */

const USER_INPUT_STEP = 14;
const PLANNER_STEP = 15;
const INBOUND_MESSAGE_STEP = 101;
const TOOL_STEP = 132;
const STEP_DONE = 3;
const PLANNER_RESPONSE = 20;
const PLANNER_TEXT = 1;
const PLANNER_FINAL_TEXT = 8;
const PLANNER_TOOL_CALLS = 7;
const INBOUND_MESSAGE = 114;
const INBOUND_BODY = 4;
const INBOUND_SENDER = 3;
const INBOUND_CONTENT = 4;
const MAX_STEP_BYTES = 1024 * 1024;
const SENDER = /\bsender=([A-Za-z0-9-]+)/;
const LIVE_TEXT_LIMIT = 16 * 1024;
const OVERSIZED_STEP_TEXT = "(The agent's reply was too large to show here.)";
const squash = (value: string) => value.replace(/\s+/g, " ").trim();

export interface AntigravityWakeStep {
  readonly idx: number;
  readonly type: number;
  readonly status: number;
  readonly payload: Uint8Array | null;
}

export type AntigravityWakeOutput =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "completed"; readonly toolCallId: string; readonly result: string };

const inboundMessage = (payload: Uint8Array) => {
  try {
    const body = message(message(payload, INBOUND_MESSAGE), INBOUND_BODY);
    const rendered = text(message(payload, INBOUND_MESSAGE), 1) ?? "";
    const sender = text(body, INBOUND_SENDER) ?? SENDER.exec(rendered)?.[1];
    if (sender === undefined) return undefined;
    const content = text(body, INBOUND_CONTENT) ?? rendered.split("content=").slice(1).join("");
    return { sender, content };
  } catch {
    return undefined;
  }
};

const plannerResponse = (payload: Uint8Array) => {
  try {
    const response = message(payload, PLANNER_RESPONSE);
    return {
      text: (text(response, PLANNER_FINAL_TEXT) ?? text(response, PLANNER_TEXT) ?? "").trim(),
      hasToolCalls: response !== undefined && messages(response, PLANNER_TOOL_CALLS).length > 0,
    };
  } catch {
    return undefined;
  }
};

/**
 * One turn's wake state; `reset` starts the next turn clean.
 * Follows `invoke_subagent` calls through the parent's steps: the record that names the
 * child, the child's message back, and the planner steps of the run that message wakes.
 * That run ends at the first planner step without tool calls.
 */
export function makeAntigravityWakeTracker() {
  const launched = new Set<string>();
  const childCalls = new Map<string, string>();
  const woken = new Map<string, string>();
  let cursor: number | undefined;
  let wakeStep: number | undefined;
  let liveText = "";
  let runHasText = false;

  const forget = (toolCallId: string) => {
    launched.delete(toolCallId);
    woken.delete(toolCallId);
    for (const [childId, call] of childCalls) {
      if (call === toolCallId) childCalls.delete(childId);
    }
  };

  // Steps the stream delivered keep their place in the buffer until their log copy is seen.
  const consumeLive = (planned: string) => {
    const needle = squash(planned);
    if (needle.length === 0) return false;
    const live = squash(liveText);
    const at = live.indexOf(needle);
    if (at < 0) return false;
    liveText = live.slice(at + needle.length);
    return true;
  };

  const finishRun = (outputs: Array<AntigravityWakeOutput>) => {
    for (const [toolCallId, result] of woken) {
      outputs.push({ type: "completed", toolCallId, result });
      forget(toolCallId);
    }
    woken.clear();
    wakeStep = undefined;
    runHasText = false;
  };

  return {
    launch: (toolCallId: string) => {
      launched.add(toolCallId);
    },
    tracks: (toolCallId: string) => launched.has(toolCallId),
    pendingIds: () => [...launched],
    /** A launch that failed or was cancelled has no wake to wait for. */
    drop: forget,
    reset: () => {
      launched.clear();
      childCalls.clear();
      woken.clear();
      cursor = undefined;
      wakeStep = undefined;
      liveText = "";
      runHasText = false;
    },
    /** Text the stream already delivered, so the log's copy of it is not shown twice. */
    observeLiveText: (chunk: string) => {
      liveText = (liveText + chunk).slice(-LIVE_TEXT_LIMIT);
    },
    pending: () => launched.size > 0,
    cursor: () => cursor,
    advance: (steps: ReadonlyArray<AntigravityWakeStep>) => {
      const outputs: Array<AntigravityWakeOutput> = [];
      for (const step of steps) {
        // A step still being written is read again, so output keeps the log's order.
        if (step.status !== STEP_DONE) break;
        cursor = step.idx;
        if (step.payload === null) {
          // An oversized planner step cannot be read, but it must still end the wake.
          if (step.type === PLANNER_STEP && wakeStep !== undefined) {
            outputs.push({
              type: "text",
              text: `${runHasText ? "\n\n" : ""}${OVERSIZED_STEP_TEXT}`,
            });
            finishRun(outputs);
          }
          continue;
        }
        if (step.type === TOOL_STEP) {
          const record = decodeInvokeRecord(step.payload);
          if (record !== undefined && launched.has(record.toolCallId)) {
            for (const childId of record.conversationIds)
              childCalls.set(childId, record.toolCallId);
          }
        } else if (step.type === INBOUND_MESSAGE_STEP) {
          const inbound = inboundMessage(step.payload);
          const toolCallId = inbound === undefined ? undefined : childCalls.get(inbound.sender);
          if (inbound !== undefined && toolCallId !== undefined) {
            woken.set(toolCallId, inbound.content);
            wakeStep ??= step.idx;
          }
        } else if (step.type === PLANNER_STEP) {
          const planner = plannerResponse(step.payload);
          if (planner === undefined) continue;
          // Steps before the wake belong to the prompt the stream carried.
          const delivered = consumeLive(planner.text);
          if (wakeStep === undefined) continue;
          if (planner.text.length > 0 && !delivered) {
            outputs.push({ type: "text", text: `${runHasText ? "\n\n" : ""}${planner.text}` });
            runHasText = true;
          }
          if (!planner.hasToolCalls) finishRun(outputs);
        }
      }
      return outputs;
    },
  };
}

export type AntigravityWakeTracker = ReturnType<typeof makeAntigravityWakeTracker>;

/** Finished steps after `after`, or after the latest user input when the log has not been read yet. */
export const readAntigravityWakeSteps = Effect.fn("AntigravityWake.read")(function* (
  profileDirectory: string,
  sessionId: string,
  after: number | undefined,
) {
  const segments = [...ANTIGRAVITY_CONVERSATION_SEGMENTS, `${sessionId}.db`];
  const file = yield* Effect.promise(async () => {
    const root = await antigravityProfileRoot(profileDirectory);
    return root === undefined ? undefined : antigravityManagedPath(root, segments, "file");
  });
  if (file === undefined) return [];
  const steps = yield* readSteps(file.path, (database) => {
    const floor =
      after ??
      Number(
        database
          .prepare("SELECT max(idx) AS idx FROM steps WHERE step_type = ?")
          .get(USER_INPUT_STEP)?.idx ?? -1,
      );
    return database
      .prepare(
        `SELECT idx, step_type AS type, status,
                CASE WHEN length(step_payload) <= ? THEN step_payload END AS payload
         FROM steps WHERE idx > ? AND step_type IN (?, ?, ?) ORDER BY idx`,
      )
      .all(MAX_STEP_BYTES, floor, PLANNER_STEP, INBOUND_MESSAGE_STEP, TOOL_STEP)
      .map((row): AntigravityWakeStep => ({
        idx: Number(row.idx),
        type: Number(row.type),
        status: Number(row.status),
        payload: row.payload instanceof Uint8Array ? row.payload : null,
      }));
  }).pipe(Effect.orElseSucceed(() => undefined));
  return steps ?? [];
});
