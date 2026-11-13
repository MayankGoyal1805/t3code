// @effect-diagnostics nodeBuiltinImport:off -- node:sqlite and node:fs edit agy's native conversation database.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { type SelfInvocation, selfInvocationArgs } from "@t3tools/shared/nodeRuntime";

import { varintField } from "./AntigravityProto.ts";

/** agy versions whose private conversation storage this module was verified against. */
const ANTIGRAVITY_ROLLBACK_TESTED_VERSIONS: ReadonlyArray<string> = [
  "1.5.0",
  "1.5.1",
  "1.5.3",
  "1.5.8",
];

class AntigravityRollbackError extends Schema.TaggedError<AntigravityRollbackError>()(
  "AntigravityRollbackError",
  { cause: Schema.Defect() },
) {}

const USER_INPUT_STEP = 14;
const PLANNER_STEP = 15;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const isAntigravityRollbackVersionTested = (version: string | undefined) =>
  version !== undefined && ANTIGRAVITY_ROLLBACK_TESTED_VERSIONS.includes(version);

const conversationFile = (conversationsDir: string, sessionId: string) =>
  NodePath.join(conversationsDir, `${sessionId}.db`);

const withDatabase = <A>(
  file: string,
  options: NodeSqlite.DatabaseSyncOptions,
  use: (database: NodeSqlite.DatabaseSync) => A,
): A => {
  const database = new NodeSqlite.DatabaseSync(file, options);
  try {
    database.exec("PRAGMA busy_timeout = 2000");
    return use(database);
  } finally {
    database.close();
  }
};

const userStepIndexes = (database: NodeSqlite.DatabaseSync) =>
  database
    .prepare("SELECT idx FROM steps WHERE step_type = ? ORDER BY idx")
    .all(USER_INPUT_STEP)
    .map((row) => Number(row.idx));

const scalar = (database: NodeSqlite.DatabaseSync, sql: string, ...params: Array<number>) =>
  Number(database.prepare(sql).get(...params)?.n ?? 0);

const replaceBytes = (source: Uint8Array, search: Uint8Array, replacement: Uint8Array) => {
  const buffer = Buffer.from(source);
  const needle = Buffer.from(search);
  const parts: Array<Buffer> = [];
  let from = 0;
  for (let at = buffer.indexOf(needle); at !== -1; at = buffer.indexOf(needle, from)) {
    parts.push(buffer.subarray(from, at), Buffer.from(replacement));
    from = at + needle.length;
  }
  parts.push(buffer.subarray(from));
  return Buffer.concat(parts);
};

/**
 * Where agy keeps the conversation's own id. Step payloads and metadata also carry it, but only as
 * a back-reference (alongside the user's text and `brain/<id>` artifact paths), which stays valid
 * because the source conversation is left intact.
 */
const SESSION_ID_COLUMNS: ReadonlyArray<readonly [table: string, column: string]> = [
  ["trajectory_meta", "cascade_id"],
  ["trajectory_metadata_blob", "data"],
];

const rewriteSessionId = (database: NodeSqlite.DatabaseSync, oldId: string, newId: string) => {
  const oldBytes = Buffer.from(oldId);
  const newBytes = Buffer.from(newId);
  for (const [table, column] of SESSION_ID_COLUMNS) {
    const rows = database
      .prepare(
        `SELECT rowid AS id, "${column}" AS value FROM "${table}"
         WHERE typeof("${column}") IN ('text', 'blob') AND instr(CAST("${column}" AS BLOB), ?) > 0`,
      )
      .all(oldBytes);
    const update = database.prepare(`UPDATE "${table}" SET "${column}" = ? WHERE rowid = ?`);
    for (const row of rows) {
      const replaced =
        typeof row.value === "string"
          ? row.value.replaceAll(oldId, newId)
          : row.value instanceof Uint8Array
            ? replaceBytes(row.value, oldBytes, newBytes)
            : undefined;
      if (replaced !== undefined) update.run(replaced, Number(row.id));
    }
  }
};

/** agy writes one executor row per execution (a subagent wake-up adds one); field 3 is its last step. */
const EXECUTOR_END_STEP_FIELD = 3;

/** Number of executor rows ending before `cutoff`, or undefined when the cut is not on an execution boundary. */
const executorRowsKept = (database: NodeSqlite.DatabaseSync, cutoff: number) => {
  const stepIndexes = new Set(
    database
      .prepare("SELECT idx FROM steps")
      .all()
      .map((row) => Number(row.idx)),
  );
  const ends: Array<number> = [];
  for (const row of database.prepare("SELECT data FROM executor_metadata ORDER BY idx").all()) {
    if (!(row.data instanceof Uint8Array)) return undefined;
    let end: number | undefined;
    try {
      end = varintField(row.data, EXECUTOR_END_STEP_FIELD);
    } catch {
      return undefined;
    }
    if (end === undefined || !stepIndexes.has(end) || end <= (ends.at(-1) ?? -1)) return undefined;
    ends.push(end);
  }
  const kept = ends.filter((end) => end < cutoff).length;
  return kept > 0 && ends[kept - 1] === cutoff - 1 ? kept : undefined;
};

/** Truncates the copy to the first `keepTurns` user turns; the reason when the mapping is unsafe. */
const truncateCopy = (
  database: NodeSqlite.DatabaseSync,
  keepTurns: number,
  expectedTurns: number,
): string | undefined => {
  // Subagent children are separate databases; only nested trajectories or a child copy are unsafe.
  const isNested =
    scalar(database, "SELECT count(*) AS n FROM steps WHERE has_subtrajectory != 0") > 0 ||
    scalar(database, "SELECT count(*) AS n FROM parent_references") > 0;
  if (isNested) return "the conversation has nested trajectories";

  const userSteps = userStepIndexes(database);
  // T3's terminal turns and agy's user steps must pair one-to-one, or the cut would land on the wrong turn.
  if (userSteps.length !== expectedTurns) {
    return `agy holds ${userSteps.length} user turns but T3 Code counts ${expectedTurns}`;
  }
  const cutoff = userSteps[keepTurns];
  if (cutoff === undefined) return `agy has no user turn ${keepTurns + 1} to cut before`;

  // Generation metadata must line up one-to-one with planner steps to be cut by position.
  const plannerSteps = scalar(
    database,
    "SELECT count(*) AS n FROM steps WHERE step_type = ?",
    PLANNER_STEP,
  );
  if (scalar(database, "SELECT count(*) AS n FROM gen_metadata") !== plannerSteps) {
    return "generation metadata does not match the planner steps";
  }
  const keptExecutions = executorRowsKept(database, cutoff);
  if (keptExecutions === undefined) return "the cut is not on an execution boundary";
  const keptPlannerSteps = scalar(
    database,
    "SELECT count(*) AS n FROM steps WHERE step_type = ? AND idx < ?",
    PLANNER_STEP,
    cutoff,
  );

  database.exec("BEGIN IMMEDIATE");
  database.prepare("DELETE FROM steps WHERE idx >= ?").run(cutoff);
  database.prepare("DELETE FROM gen_metadata WHERE idx >= ?").run(keptPlannerSteps);
  database.prepare("DELETE FROM executor_metadata WHERE idx >= ?").run(keptExecutions);
  database.exec("COMMIT");
  return undefined;
};

const removeQuietly = (file: string) => {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    NodeFS.rmSync(`${file}${suffix}`, { force: true });
  }
};

/**
 * Copies an agy conversation truncated to its first `keepTurns` user turns under a new session id.
 * Returns undefined when the copy would be unsafe, so callers fall back to a fresh session.
 */
export interface AntigravityRollbackInput {
  readonly conversationsDir: string;
  readonly sessionId: string;
  readonly keepTurns: number;
  /** Terminal T3 turns of the thread; the conversation must hold exactly this many user turns. */
  readonly expectedTurns: number;
  readonly version?: string | undefined;
  readonly newSessionId?: string;
}

export type AntigravityRollbackOutcome =
  | { readonly sessionId: string }
  | { readonly refusal: string };

export const attemptAntigravityRollback = Effect.fn("AntigravityRollback.attempt")(function* (
  input: AntigravityRollbackInput,
) {
  if (!isAntigravityRollbackVersionTested(input.version)) {
    return { refusal: `agy ${input.version ?? "(unknown version)"} is not a tested version` };
  }
  if (input.keepTurns < 1) return { refusal: "no earlier turn to keep" };
  if (!SESSION_ID.test(input.sessionId))
    return { refusal: "the session id is not a conversation id" };
  const newSessionId = input.newSessionId ?? NodeCrypto.randomUUID();
  if (newSessionId.length !== input.sessionId.length || newSessionId === input.sessionId) {
    return { refusal: "the new session id is not usable" };
  }
  const source = conversationFile(input.conversationsDir, input.sessionId);
  const target = conversationFile(input.conversationsDir, newSessionId);
  const temp = NodePath.join(input.conversationsDir, `.${newSessionId}.rollback`);

  const result: AntigravityRollbackOutcome = yield* Effect.try({
    try: (): AntigravityRollbackOutcome => {
      if (!NodeFS.existsSync(source)) return { refusal: "the conversation file is missing" };
      if (NodeFS.existsSync(target)) return { refusal: "the new conversation already exists" };
      removeQuietly(temp);
      withDatabase(source, { readOnly: true }, (database) => {
        database.prepare("VACUUM INTO ?").run(temp);
      });
      const refusal = withDatabase(temp, {}, (database) => {
        const reason = truncateCopy(database, input.keepTurns, input.expectedTurns);
        if (reason !== undefined) return reason;
        database.exec("BEGIN IMMEDIATE");
        rewriteSessionId(database, input.sessionId, newSessionId);
        database.exec("COMMIT");
        return undefined;
      });
      if (refusal !== undefined) return { refusal };
      NodeFS.renameSync(temp, target);
      return { sessionId: newSessionId };
    },
    catch: (cause) => new AntigravityRollbackError({ cause }),
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed<AntigravityRollbackOutcome>({
        refusal: `the conversation could not be copied: ${String(error.cause)}`,
      }),
    ),
  );
  // Rename moves the temp file; on every other path it is still there.
  removeQuietly(temp);
  return result;
});

/** The truncated copy's session id, or undefined when the copy would be unsafe. */
export const rollbackAntigravityConversation = (input: AntigravityRollbackInput) =>
  attemptAntigravityRollback(input).pipe(
    Effect.map((outcome) => ("sessionId" in outcome ? outcome : undefined)),
  );

const decodeRollbackInput = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      conversationsDir: Schema.String,
      sessionId: Schema.String,
      keepTurns: Schema.Number,
      expectedTurns: Schema.Number,
      version: Schema.optional(Schema.String),
      newSessionId: Schema.optionalKey(Schema.String),
    }),
  ),
);

/** Body of the `__agy-rollback` process: copying a conversation can take seconds on a large database. */
export const runAntigravityRollbackWorker = async (rawInput: string) => {
  const result = await Effect.runPromise(attemptAntigravityRollback(decodeRollbackInput(rawInput)));
  process.stdout.write(JSON.stringify(result));
};

const decodeRollbackResult = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Union([
      Schema.Struct({ sessionId: Schema.String }),
      Schema.Struct({ refusal: Schema.String }),
    ]),
  ),
);

const ROLLBACK_TIMEOUT_MILLIS = 120_000;

/** Runs the rollback in a separate process so the server's event loop never waits on the database. */
export const rollbackAntigravityConversationOffThread = Effect.fn(
  "AntigravityRollback.rollbackOffThread",
)(function* (invocation: SelfInvocation, input: AntigravityRollbackInput) {
  return yield* Effect.tryPromise({
    try: (signal) =>
      new Promise<string>((resolve, reject) => {
        NodeChildProcess.execFile(
          invocation.command,
          [...selfInvocationArgs(invocation, ["__agy-rollback", JSON.stringify(input)])],
          {
            signal,
            timeout: ROLLBACK_TIMEOUT_MILLIS,
            encoding: "utf8",
            windowsHide: true,
            env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
          },
          (error, output) => (error ? reject(error) : resolve(output)),
        );
      }).then((output) => decodeRollbackResult(output)),
    catch: (cause) => new AntigravityRollbackError({ cause }),
  }).pipe(
    Effect.tapError((cause) =>
      Effect.logWarning("agy conversation rollback process failed", { cause }),
    ),
    Effect.orElseSucceed((): AntigravityRollbackOutcome => ({
      refusal: "the rollback process failed",
    })),
  );
});
