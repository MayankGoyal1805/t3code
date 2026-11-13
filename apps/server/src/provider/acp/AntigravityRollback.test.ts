import * as NodeSqlite from "node:sqlite";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { ProviderTurnId } from "@t3tools/contracts";
import { makeAntigravityAcpAdapterFlavor } from "../../orchestration-v2/Adapters/AntigravityAdapterV2.ts";
import {
  attemptAntigravityRollback,
  isAntigravityRollbackVersionTested,
  rollbackAntigravityConversation,
  rollbackAntigravityConversationOffThread,
} from "./AntigravityRollback.ts";

const OLD_ID = "e6aba774-5472-4277-b6ee-27b2e05570a7";
const NEW_ID = "11111111-2222-4333-8444-555555555555";
const OTHER_ID = "11111111-2222-4333-8444-666666666666";
const USER = 14;
const PLANNER = 15;
const TOOL = 132;
const CHILD_MESSAGE = 101;

// Schema copied from an agy 1.5.1 conversation database.
const SCHEMA = [
  "CREATE TABLE `trajectory_meta` (`trajectory_id` text,`cascade_id` text,`trajectory_type` integer,`source` integer,PRIMARY KEY (`trajectory_id`))",
  "CREATE TABLE `steps` (`idx` integer,`step_type` integer NOT NULL DEFAULT 0,`status` integer NOT NULL DEFAULT 0,`has_subtrajectory` numeric NOT NULL DEFAULT false,`metadata` blob,`error_details` blob,`permissions` blob,`task_details` blob,`render_info` blob,`step_payload` blob,`step_format` integer NOT NULL DEFAULT 0,PRIMARY KEY (`idx`))",
  "CREATE TABLE `gen_metadata` (`idx` integer,`data` blob,`size` integer NOT NULL DEFAULT 0,PRIMARY KEY (`idx`))",
  "CREATE TABLE `executor_metadata` (`idx` integer,`data` blob,PRIMARY KEY (`idx`))",
  "CREATE TABLE `parent_references` (`idx` integer,`data` blob,PRIMARY KEY (`idx`))",
  'CREATE TABLE `trajectory_metadata_blob` (`id` text DEFAULT "main",`data` blob,PRIMARY KEY (`id`))',
];

// Three turns; the second runs tools (step 132, also subagent launches) and receives a child message.
const STEP_TYPES = [
  USER,
  PLANNER,
  USER,
  PLANNER,
  TOOL,
  PLANNER,
  TOOL,
  PLANNER,
  CHILD_MESSAGE,
  PLANNER,
  USER,
  PLANNER,
];
const PLANNER_COUNT = STEP_TYPES.filter((type) => type === PLANNER).length;

// Executor rows are protobufs: field 3 is the last step of the execution, field 9 its execution id.
const executorRow = (endStep: number) =>
  Buffer.concat([
    Buffer.from([0x08, 0x04, 0x18, endStep, 0x4a, OLD_ID.length]),
    Buffer.from(OLD_ID),
  ]);

// One execution per user turn: each ends right before the next user step.
const DEFAULT_EXECUTION_ENDS = [1, 9, 11];

const writeConversation = (
  file: string,
  options: {
    readonly stepTypes?: ReadonlyArray<number>;
    readonly subtrajectoryAt?: number;
    readonly executionEnds?: ReadonlyArray<number>;
  } = {},
) => {
  const stepTypes = options.stepTypes ?? STEP_TYPES;
  const database = new NodeSqlite.DatabaseSync(file);
  try {
    database.exec("PRAGMA journal_mode = WAL");
    for (const statement of SCHEMA) database.exec(statement);
    database.prepare("INSERT INTO trajectory_meta VALUES (?, ?, 0, 0)").run(OLD_ID, OLD_ID);
    database
      .prepare("INSERT INTO trajectory_metadata_blob VALUES ('main', ?)")
      .run(Buffer.from(`\x0a\x24${OLD_ID}\x10\x01`));
    const insertStep = database.prepare(
      "INSERT INTO steps (idx, step_type, has_subtrajectory, metadata, step_payload) VALUES (?, ?, ?, ?, ?)",
    );
    stepTypes.forEach((type, idx) => {
      insertStep.run(
        idx,
        type,
        idx === options.subtrajectoryAt ? 1 : 0,
        `meta ${OLD_ID} ${idx}`,
        Buffer.from(`\x0a${OLD_ID}step${idx}`),
      );
    });
    const plannerSteps = stepTypes.filter((type) => type === PLANNER).length;
    for (let idx = 0; idx < plannerSteps; idx++) {
      database
        .prepare("INSERT INTO gen_metadata VALUES (?, ?, 1)")
        .run(idx, Buffer.from(`gen${idx}`));
    }
    (options.executionEnds ?? DEFAULT_EXECUTION_ENDS).forEach((end, idx) => {
      database.prepare("INSERT INTO executor_metadata VALUES (?, ?)").run(idx, executorRow(end));
    });
  } finally {
    database.close();
  }
};

const readRows = (file: string, sql: string) => {
  const database = new NodeSqlite.DatabaseSync(file, { readOnly: true });
  try {
    return database.prepare(sql).all();
  } finally {
    database.close();
  }
};

const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped();
  return {
    directory,
    fs,
    sourceFile: path.join(directory, `${OLD_ID}.db`),
    newFile: path.join(directory, `${NEW_ID}.db`),
  };
});

const rollback = (
  directory: string,
  overrides: Partial<Parameters<typeof rollbackAntigravityConversation>[0]> = {},
) =>
  rollbackAntigravityConversation({
    conversationsDir: directory,
    sessionId: OLD_ID,
    keepTurns: 2,
    expectedTurns: 3,
    version: "1.5.1",
    newSessionId: NEW_ID,
    ...overrides,
  });

describe("rollbackAntigravityConversation", () => {
  it.effect("truncates a copy to the kept turns under a new conversation id", () =>
    Effect.gen(function* () {
      const { directory, fs, sourceFile, newFile } = yield* setup;
      writeConversation(sourceFile);

      assert.deepEqual(yield* rollback(directory), { sessionId: NEW_ID });

      assert.deepEqual(
        readRows(newFile, "SELECT idx, step_type FROM steps ORDER BY idx").map(
          (row) => row.step_type,
        ),
        STEP_TYPES.slice(0, 10),
      );
      assert.equal(readRows(newFile, "SELECT idx FROM gen_metadata").length, PLANNER_COUNT - 1);
      assert.equal(readRows(newFile, "SELECT idx FROM executor_metadata").length, 2);

      const rows = readRows(
        newFile,
        "SELECT cascade_id AS text, (SELECT data FROM trajectory_metadata_blob) AS blob, (SELECT metadata FROM steps WHERE idx = 0) AS meta, (SELECT step_payload FROM steps WHERE idx = 1) AS payload, (SELECT data FROM executor_metadata WHERE idx = 0) AS exec FROM trajectory_meta",
      );
      const row = rows[0];
      assert.equal(row?.text, NEW_ID);
      const blobText = Buffer.from(row?.blob as Uint8Array).toString("latin1");
      assert.include(blobText, NEW_ID);
      assert.notInclude(blobText, OLD_ID);
      // Step contents keep the old id: the source conversation and its artifacts stay in place.
      assert.include(String(row?.meta), OLD_ID);
      for (const value of [row?.payload, row?.exec]) {
        const text = Buffer.from(value as Uint8Array).toString("latin1");
        assert.include(text, OLD_ID);
        assert.notInclude(text, NEW_ID);
      }

      // The source stays intact and no temp files remain.
      assert.equal(readRows(sourceFile, "SELECT idx FROM steps").length, STEP_TYPES.length);
      assert.deepEqual(
        (yield* fs.readDirectory(directory)).filter((name) => !name.startsWith(OLD_ID)).toSorted(),
        [`${NEW_ID}.db`],
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("keeps every execution of the kept turns when a subagent woke one of them", () =>
    Effect.gen(function* () {
      const { directory, sourceFile, newFile } = yield* setup;
      // Turn two (steps 2-9) holds two executions: the second starts when the subagent reports back.
      writeConversation(sourceFile, { executionEnds: [1, 5, 9, 11] });

      assert.deepEqual(yield* rollback(directory), { sessionId: NEW_ID });
      assert.equal(readRows(newFile, "SELECT idx FROM executor_metadata").length, 3);
      assert.deepEqual(yield* rollback(directory, { keepTurns: 1, newSessionId: OTHER_ID }), {
        sessionId: OTHER_ID,
      });
      assert.equal(
        readRows(sourceFile.replace(OLD_ID, OTHER_ID), "SELECT idx FROM executor_metadata").length,
        1,
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("refuses conversations it cannot map safely and leaves nothing behind", () =>
    Effect.gen(function* () {
      const { directory, fs, sourceFile } = yield* setup;
      writeConversation(sourceFile);

      assert.isUndefined(yield* rollback(directory, { version: "1.4.5" }));
      assert.isTrue(isAntigravityRollbackVersionTested("1.5.8"));
      assert.isUndefined(yield* rollback(directory, { keepTurns: 0 }));
      assert.isUndefined(yield* rollback(directory, { keepTurns: 3 }));
      assert.isUndefined(yield* rollback(directory, { expectedTurns: 2 }));
      assert.isUndefined(yield* rollback(directory, { sessionId: "not-a-uuid" }));
      assert.deepEqual(
        yield* fs
          .readDirectory(directory)
          .pipe(Effect.map((names) => names.filter((name) => !name.startsWith(OLD_ID)))),
        [],
      );

      yield* fs.remove(sourceFile);
      writeConversation(sourceFile, { subtrajectoryAt: 3 });
      assert.isUndefined(yield* rollback(directory));
      yield* fs.remove(sourceFile);
      // Planner steps without matching generation metadata cannot be cut by position.
      writeConversation(sourceFile);
      const database = new NodeSqlite.DatabaseSync(sourceFile);
      database.exec("DELETE FROM gen_metadata WHERE idx = 0");
      database.close();
      assert.isUndefined(yield* rollback(directory));
      // The last kept execution ends at step 8, not right before the cut at step 10.
      yield* fs.remove(sourceFile);
      writeConversation(sourceFile, { executionEnds: [1, 8, 11] });
      assert.isUndefined(yield* rollback(directory));
      yield* fs.remove(sourceFile);
      writeConversation(sourceFile, { executionEnds: [1, 9, 9] });
      assert.isUndefined(yield* rollback(directory));
      assert.deepEqual(
        (yield* fs.readDirectory(directory)).filter((name) => !name.startsWith(OLD_ID)),
        [],
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("runs the rollback in a separate process through the server entrypoint", () =>
    Effect.gen(function* () {
      const { directory, sourceFile, newFile } = yield* setup;
      writeConversation(sourceFile);
      const invocation = {
        command: process.execPath,
        entrypoint: NodeURL.fileURLToPath(new URL("../../bin.ts", import.meta.url)),
      };
      const input = {
        conversationsDir: directory,
        sessionId: OLD_ID,
        keepTurns: 2,
        expectedTurns: 3,
        version: "1.5.1",
        newSessionId: NEW_ID,
      };

      assert.deepEqual(yield* rollbackAntigravityConversationOffThread(invocation, input), {
        sessionId: NEW_ID,
      });
      assert.equal(readRows(newFile, "SELECT idx FROM steps").length, 10);
      assert.deepEqual(
        yield* rollbackAntigravityConversationOffThread(invocation, { ...input, keepTurns: 0 }),
        { refusal: "no earlier turn to keep" },
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});

describe("rollback of a conversation with wakes", () => {
  // Turn one, a wake agy ran on its own (a system message, no user step), then turn two.
  const WAKE_STEPS = [USER, PLANNER, 101, PLANNER, USER, PLANNER];
  const turn = (ordinal: number, session: string) =>
    ({
      id: ProviderTurnId.make(`turn-${ordinal}`),
      ordinal,
      status: "completed",
      nativeTurnRef: { driver: "antigravity", nativeId: `${session}:turn:${ordinal}` },
    }) as never;

  it.effect("says why it refuses", () =>
    Effect.gen(function* () {
      const { directory, sourceFile } = yield* setup;
      writeConversation(sourceFile);
      const refusal = yield* attemptAntigravityRollback({
        conversationsDir: directory,
        sessionId: OLD_ID,
        keepTurns: 2,
        expectedTurns: 5,
        version: "1.5.8",
        newSessionId: NEW_ID,
      });
      assert.deepEqual(refusal, {
        refusal: "agy holds 3 user turns but T3 Code counts 5",
      });
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("pairs only the turns that carry a prompt with agy's user steps", () =>
    Effect.gen(function* () {
      const { directory, fs } = yield* setup;
      const path = yield* Path.Path;
      const profile = path.join(directory, "profile");
      const conversations = path.join(profile, "antigravity-cli", "conversations");
      yield* fs.makeDirectory(conversations, { recursive: true });
      writeConversation(path.join(conversations, `${OLD_ID}.db`), {
        stepTypes: WAKE_STEPS,
        executionEnds: [1, 3, 5],
      });
      const flavor = makeAntigravityAcpAdapterFlavor({
        instanceId: "antigravity-rollback-test" as never,
        selfInvocation: {
          command: process.execPath,
          entrypoint: NodeURL.fileURLToPath(new URL("../../bin.ts", import.meta.url)),
        },
        makeRuntime: () => Effect.die("unused"),
        withProcess: () => Effect.die("unused"),
        defaultModel: Effect.undefined,
        version: Effect.succeed("1.5.8"),
        profileDirectory: profile,
        random: undefined as never,
        fileSystem: fs,
        path,
        host: undefined as never,
      });
      const turns = [turn(1, OLD_ID), turn(2, OLD_ID), turn(3, OLD_ID), turn(4, "other")];
      const input = (target: number) => ({
        providerThread: undefined as never,
        target: { type: "provider_turn", providerTurn: turns[target - 1] } as never,
        providerThreadTurns: turns,
        providerStartedTurnIds: Effect.succeed(new Set([ProviderTurnId.make("turn-2")])),
        cwd: directory,
        nativeSessionId: OLD_ID,
      });

      // Editing turn two's prompt: the wake before it is kept, and agy's second user step is cut.
      const kept = yield* flavor.rollbackSession!(input(2));
      assert.isDefined(kept);
      assert.equal(
        readRows(path.join(conversations, `${kept!.sessionId}.db`), "SELECT idx FROM steps").length,
        4,
      );
      // The wake after turn one would have to be cut from inside, which agy has no step for.
      assert.isUndefined(yield* flavor.rollbackSession!(input(1)));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
