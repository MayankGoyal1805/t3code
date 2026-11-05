import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  countAntigravityUserTurns,
  rollbackAntigravityConversation,
} from "./AntigravityRollback.ts";

const OLD_ID = "e6aba774-5472-4277-b6ee-27b2e05570a7";
const NEW_ID = "11111111-2222-4333-8444-555555555555";
const USER = 14;
const PLANNER = 15;
const TOOL = 8;
const SUBAGENT = 132;

// Schema copied from an agy 1.5.1 conversation database.
const SCHEMA = [
  "CREATE TABLE `trajectory_meta` (`trajectory_id` text,`cascade_id` text,`trajectory_type` integer,`source` integer,PRIMARY KEY (`trajectory_id`))",
  "CREATE TABLE `steps` (`idx` integer,`step_type` integer NOT NULL DEFAULT 0,`status` integer NOT NULL DEFAULT 0,`has_subtrajectory` numeric NOT NULL DEFAULT false,`metadata` blob,`error_details` blob,`permissions` blob,`task_details` blob,`render_info` blob,`step_payload` blob,`step_format` integer NOT NULL DEFAULT 0,PRIMARY KEY (`idx`))",
  "CREATE TABLE `gen_metadata` (`idx` integer,`data` blob,`size` integer NOT NULL DEFAULT 0,PRIMARY KEY (`idx`))",
  "CREATE TABLE `executor_metadata` (`idx` integer,`data` blob,PRIMARY KEY (`idx`))",
  "CREATE TABLE `parent_references` (`idx` integer,`data` blob,PRIMARY KEY (`idx`))",
  'CREATE TABLE `trajectory_metadata_blob` (`id` text DEFAULT "main",`data` blob,PRIMARY KEY (`id`))',
];

// Three turns; the second runs a tool between two planner responses.
const STEP_TYPES = [USER, PLANNER, USER, PLANNER, TOOL, PLANNER, USER, PLANNER];
const PLANNER_COUNT = STEP_TYPES.filter((type) => type === PLANNER).length;

const writeConversation = (
  file: string,
  options: { readonly stepTypes?: ReadonlyArray<number>; readonly subtrajectoryAt?: number } = {},
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
    const userSteps = stepTypes.filter((type) => type === USER).length;
    for (let idx = 0; idx < plannerSteps; idx++) {
      database
        .prepare("INSERT INTO gen_metadata VALUES (?, ?, 1)")
        .run(idx, Buffer.from(`gen${idx}`));
    }
    for (let idx = 0; idx < userSteps; idx++) {
      database
        .prepare("INSERT INTO executor_metadata VALUES (?, ?)")
        .run(idx, Buffer.from(`${OLD_ID}exec${idx}`));
    }
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
    version: "1.5.1",
    newSessionId: NEW_ID,
    ...overrides,
  });

describe("rollbackAntigravityConversation", () => {
  it.effect("truncates a copy to the kept turns under a rewritten id", () =>
    Effect.gen(function* () {
      const { directory, fs, sourceFile, newFile } = yield* setup;
      writeConversation(sourceFile);

      assert.equal(
        yield* countAntigravityUserTurns({ conversationsDir: directory, sessionId: OLD_ID }),
        3,
      );
      assert.deepEqual(yield* rollback(directory), { sessionId: NEW_ID });

      assert.deepEqual(
        readRows(newFile, "SELECT idx, step_type FROM steps ORDER BY idx").map(
          (row) => row.step_type,
        ),
        STEP_TYPES.slice(0, 6),
      );
      assert.equal(readRows(newFile, "SELECT idx FROM gen_metadata").length, PLANNER_COUNT - 1);
      assert.equal(readRows(newFile, "SELECT idx FROM executor_metadata").length, 2);

      const rows = readRows(
        newFile,
        "SELECT trajectory_id AS text, (SELECT data FROM trajectory_metadata_blob) AS blob, (SELECT metadata FROM steps WHERE idx = 0) AS meta, (SELECT step_payload FROM steps WHERE idx = 1) AS payload, (SELECT data FROM executor_metadata WHERE idx = 0) AS exec FROM trajectory_meta",
      );
      const row = rows[0];
      assert.equal(row?.text, NEW_ID);
      assert.include(String(row?.meta), NEW_ID);
      for (const value of [row?.blob, row?.payload, row?.exec]) {
        const text = Buffer.from(value as Uint8Array).toString("latin1");
        assert.include(text, NEW_ID);
        assert.notInclude(text, OLD_ID);
      }

      // The source stays intact and no temp files remain.
      assert.equal(readRows(sourceFile, "SELECT idx FROM steps").length, STEP_TYPES.length);
      assert.deepEqual(
        (yield* fs.readDirectory(directory)).filter((name) => !name.startsWith(OLD_ID)).toSorted(),
        [`${NEW_ID}.db`],
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("refuses conversations it cannot map safely and leaves nothing behind", () =>
    Effect.gen(function* () {
      const { directory, fs, sourceFile } = yield* setup;
      writeConversation(sourceFile);

      assert.isUndefined(yield* rollback(directory, { version: "1.4.5" }));
      assert.isUndefined(yield* rollback(directory, { keepTurns: 0 }));
      assert.isUndefined(yield* rollback(directory, { keepTurns: 3 }));
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
      writeConversation(sourceFile, {
        stepTypes: [USER, PLANNER, SUBAGENT, PLANNER, USER, PLANNER],
      });
      assert.isUndefined(yield* rollback(directory, { keepTurns: 1 }));
      yield* fs.remove(sourceFile);
      // Planner steps without matching generation metadata cannot be cut by position.
      writeConversation(sourceFile);
      const database = new NodeSqlite.DatabaseSync(sourceFile);
      database.exec("DELETE FROM gen_metadata WHERE idx = 0");
      database.close();
      assert.isUndefined(yield* rollback(directory));
      assert.deepEqual(
        (yield* fs.readDirectory(directory)).filter((name) => !name.startsWith(OLD_ID)),
        [],
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
