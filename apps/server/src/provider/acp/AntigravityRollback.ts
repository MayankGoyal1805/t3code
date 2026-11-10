// @effect-diagnostics nodeBuiltinImport:off -- node:sqlite and node:fs edit agy's native conversation database.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { type SelfInvocation, selfInvocationArgs } from "@t3tools/shared/nodeRuntime";

/** agy versions whose private conversation storage this module was verified against. */
const ANTIGRAVITY_ROLLBACK_TESTED_VERSIONS: ReadonlyArray<string> = ["1.5.0", "1.5.1", "1.5.3"];

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

/** Truncates the copy to the first `keepTurns` user turns; false when the mapping is unsafe. */
const truncateCopy = (
  database: NodeSqlite.DatabaseSync,
  keepTurns: number,
  expectedTurns: number,
) => {
  // Subagent children are separate databases; only nested trajectories or a child copy are unsafe.
  const isNested =
    scalar(database, "SELECT count(*) AS n FROM steps WHERE has_subtrajectory != 0") > 0 ||
    scalar(database, "SELECT count(*) AS n FROM parent_references") > 0;
  if (isNested) return false;

  const userSteps = userStepIndexes(database);
  // T3's terminal turns and agy's user steps must pair one-to-one, or the cut would land on the wrong turn.
  if (userSteps.length !== expectedTurns) return false;
  const cutoff = userSteps[keepTurns];
  if (cutoff === undefined) return false;

  // Metadata rows must line up one-to-one with turns and planner steps to be cut by position.
  const plannerSteps = scalar(
    database,
    "SELECT count(*) AS n FROM steps WHERE step_type = ?",
    PLANNER_STEP,
  );
  if (
    scalar(database, "SELECT count(*) AS n FROM gen_metadata") !== plannerSteps ||
    scalar(database, "SELECT count(*) AS n FROM executor_metadata") !== userSteps.length
  ) {
    return false;
  }
  const keptPlannerSteps = scalar(
    database,
    "SELECT count(*) AS n FROM steps WHERE step_type = ? AND idx < ?",
    PLANNER_STEP,
    cutoff,
  );

  database.exec("BEGIN IMMEDIATE");
  database.prepare("DELETE FROM steps WHERE idx >= ?").run(cutoff);
  database.prepare("DELETE FROM gen_metadata WHERE idx >= ?").run(keptPlannerSteps);
  database.prepare("DELETE FROM executor_metadata WHERE idx >= ?").run(keepTurns);
  database.exec("COMMIT");
  return true;
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

export const rollbackAntigravityConversation = Effect.fn("AntigravityRollback.rollback")(function* (
  input: AntigravityRollbackInput,
) {
  if (
    !isAntigravityRollbackVersionTested(input.version) ||
    input.keepTurns < 1 ||
    !SESSION_ID.test(input.sessionId)
  ) {
    return undefined;
  }
  const newSessionId = input.newSessionId ?? NodeCrypto.randomUUID();
  if (newSessionId.length !== input.sessionId.length || newSessionId === input.sessionId) {
    return undefined;
  }
  const source = conversationFile(input.conversationsDir, input.sessionId);
  const target = conversationFile(input.conversationsDir, newSessionId);
  const temp = NodePath.join(input.conversationsDir, `.${newSessionId}.rollback`);

  const result = yield* Effect.try({
    try: () => {
      if (!NodeFS.existsSync(source) || NodeFS.existsSync(target)) return undefined;
      removeQuietly(temp);
      withDatabase(source, { readOnly: true }, (database) => {
        database.prepare("VACUUM INTO ?").run(temp);
      });
      const truncated = withDatabase(temp, {}, (database) => {
        if (!truncateCopy(database, input.keepTurns, input.expectedTurns)) return false;
        database.exec("BEGIN IMMEDIATE");
        rewriteSessionId(database, input.sessionId, newSessionId);
        database.exec("COMMIT");
        return true;
      });
      if (!truncated) return undefined;
      NodeFS.renameSync(temp, target);
      return { sessionId: newSessionId };
    },
    catch: (cause) => new AntigravityRollbackError({ cause }),
  }).pipe(
    Effect.tapError((cause) =>
      Effect.logWarning("agy conversation rollback failed", {
        cause,
        sessionId: input.sessionId,
      }),
    ),
    Effect.orElseSucceed(() => undefined),
  );
  // Rename moves the temp file; on every other path it is still there.
  removeQuietly(temp);
  return result;
});

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
  const result = await Effect.runPromise(
    rollbackAntigravityConversation(decodeRollbackInput(rawInput)),
  );
  process.stdout.write(JSON.stringify(result ?? null));
};

const decodeRollbackResult = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.NullOr(Schema.Struct({ sessionId: Schema.String }))),
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
      }).then((output) => decodeRollbackResult(output) ?? undefined),
    catch: (cause) => new AntigravityRollbackError({ cause }),
  }).pipe(
    Effect.tapError((cause) =>
      Effect.logWarning("agy conversation rollback process failed", { cause }),
    ),
    Effect.orElseSucceed(() => undefined),
  );
});
