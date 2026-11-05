// @effect-diagnostics nodeBuiltinImport:off -- node:sqlite and lstat read the native session log.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import type { OrchestrationV2ProviderFailure } from "@t3tools/contracts";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as EffectAcpSchema from "effect-acp/compat";

import { ANTIGRAVITY_CONVERSATION_SEGMENTS } from "./AntigravityChildWork.ts";
import { message, text } from "./AntigravityProto.ts";
import { antigravityManagedPath, antigravityProfileRoot } from "./AntigravityProfilePaths.ts";

// CORTEX_STEP_TYPE_ERROR_MESSAGE in the native trajectory.
const ERROR_STEP_TYPE = 17;
// An error step carries the message plus a Go stack trace; a larger one is read as a bare failure.
const MAX_ERROR_PAYLOAD_BYTES = 256 * 1024;
const MAX_ERROR_MESSAGE_CHARS = 500;
// The Go harness's rendering of a Google API error.
const API_ERROR = /Error (\d{3}), Message: (.+?), Status: ([A-Z_]+)/s;
const QUOTA_EXHAUSTED = /\breason:QUOTA_EXHAUSTED\b/;
const RESET_TIMESTAMP = /\bquotaResetTimeStamp:([^\s\]]+)/;
const RESET_DELAY = /\bquotaResetDelay:((?:\d+(?:\.\d+)?(?:ns|us|µs|μs|ms|h|m|s))+)(?=[\s\]])/;
// google.rpc.RetryInfo, which plain rate limits carry instead of a quota reset.
const RETRY_DELAY = /\bretryDelay:((?:\d+(?:\.\d+)?(?:ns|us|µs|μs|ms|h|m|s))+)(?=[\s\]])/;
const GO_DURATION_PART = /(\d+(?:\.\d+)?)(ns|us|µs|μs|ms|h|m|s)/g;
const GO_DURATION_UNIT_MS: Record<string, number> = {
  ns: 1e-6,
  us: 1e-3,
  µs: 1e-3,
  μs: 1e-3,
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
};
const NATIVE_SESSION_ID = /^[\w-]+$/;

interface LastStep {
  readonly type: number;
  /** Error step {24: {3: {1 title, 2 detail, 3 detail with Go stack, 9 detail}}}. */
  readonly error:
    | { readonly title: string; readonly detail: string; readonly full: string }
    | undefined;
}

function decodeError(payload: Uint8Array | null): LastStep["error"] {
  if (payload === null) return undefined;
  try {
    const error = message(message(payload, 24), 3);
    const detail = text(error, 9) ?? text(error, 2) ?? "";
    return { title: text(error, 1) ?? "", detail, full: text(error, 3) ?? detail };
  } catch {
    return undefined;
  }
}

class AntigravitySessionLogError extends Schema.TaggedError<AntigravitySessionLogError>()(
  "AntigravitySessionLogError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not read the Antigravity session log.";
  }
}

const sessionLogError = (cause: unknown) => new AntigravitySessionLogError({ cause });

const readSteps = <A>(file: string, read: (database: NodeSqlite.DatabaseSync) => A) =>
  Effect.try({
    try: () => {
      const database = new NodeSqlite.DatabaseSync(file, { readOnly: true });
      try {
        database.exec("PRAGMA busy_timeout = 100");
        const hasSteps =
          database
            .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'steps'")
            .get() !== undefined;
        return hasSteps ? read(database) : undefined;
      } finally {
        database.close();
      }
    },
    catch: sessionLogError,
  });

const lastStepIndex = (database: NodeSqlite.DatabaseSync) => {
  const index = database.prepare("SELECT max(idx) AS idx FROM steps").get()?.idx;
  return typeof index === "number" ? index : -1;
};

const lastStepAfter =
  (index: number) =>
  (database: NodeSqlite.DatabaseSync): LastStep | undefined => {
    const row = database
      .prepare(
        `SELECT step_type AS type,
                CASE WHEN step_type = ? AND length(step_payload) <= ? THEN step_payload END AS payload
         FROM steps WHERE idx > ? ORDER BY idx DESC LIMIT 1`,
      )
      .get(ERROR_STEP_TYPE, MAX_ERROR_PAYLOAD_BYTES, index);
    if (typeof row?.type !== "number") return undefined;
    return {
      type: row.type,
      error: decodeError(row.payload instanceof Uint8Array ? row.payload : null),
    };
  };

function resetAtFrom(errorText: string, now: DateTime.Utc): string | undefined {
  // makeProviderFailure drops a timestamp that does not parse, so fall back to the delay.
  const timestamp = RESET_TIMESTAMP.exec(errorText)?.[1];
  if (timestamp !== undefined && Option.isSome(DateTime.make(timestamp))) return timestamp;
  const delay = RESET_DELAY.exec(errorText)?.[1] ?? RETRY_DELAY.exec(errorText)?.[1];
  if (delay === undefined) return undefined;
  let delayMs = 0;
  for (const [, amount, unit] of delay.matchAll(GO_DURATION_PART)) {
    delayMs += Number(amount) * (GO_DURATION_UNIT_MS[unit!] ?? 0);
  }
  return delayMs > 0 ? DateTime.formatIso(DateTime.add(now, { milliseconds: delayMs })) : undefined;
}

function turnFailure(
  stopReason: EffectAcpSchema.StopReason,
  step: LastStep | undefined,
  now: DateTime.Utc,
): OrchestrationV2ProviderFailure | undefined {
  const isError = step?.type === ERROR_STEP_TYPE;
  // The agent maps only the SDK's QUOTA_EXHAUSTED stop reason to `refusal`.
  if (!isError && stopReason !== "refusal") return undefined;
  const { title, detail, full } = step?.error ?? { title: "", detail: "", full: "" };
  const searchable = `${detail}\n${full}`;
  const apiError = API_ERROR.exec(searchable);
  if (stopReason === "refusal" || QUOTA_EXHAUSTED.test(searchable)) {
    return makeProviderFailure({
      class: "usage_limit",
      message: "You have reached your Antigravity quota for this period.",
      code: apiError?.[3] ?? "QUOTA_EXHAUSTED",
      retryable: true,
      resetAt: resetAtFrom(searchable, now) ?? null,
    });
  }
  if (apiError === null) {
    // Only the first line: the rest is a Go stack trace.
    const firstLine = (detail || title).split("\n", 1)[0]!.trim().slice(0, MAX_ERROR_MESSAGE_CHARS);
    return makeProviderFailure({
      class: "provider_error",
      message: firstLine || "Antigravity stopped this turn because of an error.",
    });
  }
  const [, httpStatus, apiMessage, status] = apiError;
  const rateLimited = httpStatus === "429" || status === "RESOURCE_EXHAUSTED";
  return makeProviderFailure({
    class: rateLimited ? "usage_limit" : "provider_error",
    message: apiMessage!.trim(),
    code: status ?? null,
    retryable: rateLimited || Number(httpStatus) >= 500,
    resetAt: resetAtFrom(searchable, now) ?? null,
  });
}

/**
 * Antigravity reports an upstream API failure as a chat message and `end_turn`. Its
 * session log ends that turn with an error step, so the check reads only steps the
 * current prompt added, read-only, from this session's own unlinked database. Without
 * that evidence a typed `refusal` still fails the turn.
 */
export const watchAntigravityPromptOutcome = Effect.fn("AntigravityTurnOutcome.watch")(function* (
  profileDirectory: string,
  sessionId: string,
) {
  const typedOnly = (result: EffectAcpSchema.PromptResponse) =>
    DateTime.now.pipe(Effect.map((now) => turnFailure(result.stopReason, undefined, now)));
  if (!NATIVE_SESSION_ID.test(sessionId)) return typedOnly;
  const segments = [...ANTIGRAVITY_CONVERSATION_SEGMENTS, `${sessionId}.db`];
  const before = yield* Effect.tryPromise({
    try: async () => {
      const root = await antigravityProfileRoot(profileDirectory);
      if (root === undefined) return undefined;
      if (
        (await antigravityManagedPath(root, ANTIGRAVITY_CONVERSATION_SEGMENTS, "directory")) ===
        undefined
      ) {
        return undefined;
      }
      const database = await antigravityManagedPath(root, segments, "file");
      // A path that exists but fails the proof is a link or other foreign entry.
      if (database === undefined) {
        const present = await NodeFSP.lstat(NodePath.join(root, ...segments)).then(
          () => true,
          () => false,
        );
        return present ? undefined : { root, identity: undefined, startIndex: -1 };
      }
      return { root, identity: database.info, startIndex: undefined };
    },
    catch: sessionLogError,
  }).pipe(Effect.orElseSucceed(() => undefined));
  if (before === undefined) {
    yield* Effect.logWarning("The Antigravity session log is not this session's own file.");
    return typedOnly;
  }
  const startIndex =
    before.startIndex ??
    (yield* readSteps(NodePath.join(before.root, ...segments), lastStepIndex).pipe(
      Effect.map((index) => index ?? -1),
      Effect.orElseSucceed(() => undefined),
    ));
  if (startIndex === undefined) {
    yield* Effect.logWarning("Could not read the Antigravity session log before the prompt.");
    return typedOnly;
  }
  return Effect.fn("AntigravityTurnOutcome.check")(function* (
    result: EffectAcpSchema.PromptResponse,
  ) {
    // The same file as before the prompt, or one this prompt created, still unlinked.
    const after = yield* Effect.tryPromise({
      try: () => antigravityManagedPath(before.root, segments, "file"),
      catch: sessionLogError,
    }).pipe(Effect.orElseSucceed(() => undefined));
    const sameFile =
      after !== undefined &&
      (before.identity === undefined ||
        (after.info.dev === before.identity.dev && after.info.ino === before.identity.ino));
    const step = sameFile
      ? yield* readSteps(after.path, lastStepAfter(startIndex)).pipe(
          Effect.tapError(() =>
            Effect.logWarning("Could not read the Antigravity session log after the prompt."),
          ),
          Effect.orElseSucceed(() => undefined),
        )
      : undefined;
    return turnFailure(result.stopReason, step, yield* DateTime.now);
  });
});
