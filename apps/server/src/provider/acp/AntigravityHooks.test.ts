// @effect-diagnostics nodeBuiltinImport:off -- runs the hook command in a real shell.
import * as NodeChildProcess from "node:child_process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  ANTIGRAVITY_HOOK_EVENTS_ENV,
  ANTIGRAVITY_HOOK_NAME,
  antigravityHooksConfigPath,
  ensureAntigravityHooks,
  mergeAntigravityHooksConfig,
  withoutAntigravityHook,
} from "./AntigravityHooks.ts";
import { decodeAntigravityHookLine, takeCompleteLines } from "./AntigravityHookEvents.ts";

const written = (existing: string | undefined) => {
  const merged = mergeAntigravityHooksConfig(existing);
  assert.equal(merged._tag, "Write");
  return merged._tag === "Write" ? merged.text : "";
};

describe("mergeAntigravityHooksConfig", () => {
  it("adds the entry beside other hooks and unknown keys", () => {
    const text = written(JSON.stringify({ mine: { Stop: [{ command: "echo done" }] }, extra: 1 }));
    const config = JSON.parse(text);
    assert.deepEqual(config.mine, { Stop: [{ command: "echo done" }] });
    assert.equal(config.extra, 1);
    assert.deepEqual(Object.keys(config[ANTIGRAVITY_HOOK_NAME]), [
      "PreInvocation",
      "PreToolUse",
      "PostToolUse",
      "Stop",
    ]);
    assert.equal(config[ANTIGRAVITY_HOOK_NAME].PostToolUse[0].matcher, "*");
  });

  it("is idempotent and refreshes an outdated entry", () => {
    const first = written(undefined);
    assert.deepEqual(mergeAntigravityHooksConfig(first), { _tag: "Unchanged" });
    const stale = JSON.stringify({ [ANTIGRAVITY_HOOK_NAME]: { Stop: [{ command: "old" }] } });
    assert.equal(written(stale), first);
  });

  it.each(["not json", "[]", "3"])("leaves %s alone", (text) => {
    assert.deepEqual(mergeAntigravityHooksConfig(text), { _tag: "Invalid" });
  });

  it("ignores its own entry when looking for the user's hooks", () => {
    const config = JSON.parse(written(JSON.stringify({ mine: {} })));
    assert.deepEqual(Object.keys(withoutAntigravityHook(config)), ["mine"]);
    assert.deepEqual(withoutAntigravityHook(JSON.parse(written(undefined))), {});
  });
});

describe("ensureAntigravityHooks", () => {
  const setup = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agy-hooks-test-" });
    return { fs, directory, file: antigravityHooksConfigPath(path, directory) };
  });

  it.effect("creates the file, keeps others and settles on a second run", () =>
    Effect.gen(function* () {
      const { fs, directory, file } = yield* setup;
      assert.isTrue(yield* ensureAntigravityHooks(directory));
      assert.property(JSON.parse(yield* fs.readFileString(file)), ANTIGRAVITY_HOOK_NAME);
      yield* fs.writeFileString(file, JSON.stringify({ mine: { Stop: [] } }));
      assert.isTrue(yield* ensureAntigravityHooks(directory));
      const first = yield* fs.readFileString(file);
      assert.deepEqual(Object.keys(JSON.parse(first)), ["mine", ANTIGRAVITY_HOOK_NAME]);
      assert.isTrue(yield* ensureAntigravityHooks(directory));
      assert.equal(yield* fs.readFileString(file), first);
      assert.deepEqual(yield* fs.readDirectory(`${directory}/config`), ["hooks.json"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("does not touch a file that is not JSON", () =>
    Effect.gen(function* () {
      const { fs, directory, file } = yield* setup;
      yield* fs.makeDirectory(directory, { recursive: true });
      yield* fs.makeDirectory(`${directory}/config`, { recursive: true });
      yield* fs.writeFileString(file, "{ broken");
      assert.isFalse(yield* ensureAntigravityHooks(directory));
      assert.equal(yield* fs.readFileString(file), "{ broken");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("the t3-code hook command", () => {
  const commandFor = (event: string) => {
    const entry = JSON.parse(written(undefined))[ANTIGRAVITY_HOOK_NAME];
    const handler = entry[event][0];
    return String((handler.hooks?.[0] ?? handler).command);
  };
  const run = (event: string, env: Record<string, string>, input: string) =>
    NodeChildProcess.execFileSync("/bin/sh", ["-c", commandFor(event)], {
      input,
      env: { PATH: process.env.PATH ?? "", ...env },
      encoding: "utf8",
    });

  it.effect("appends one line per event and prints nothing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agy-hook-run-" });
      const file = `${directory}/events`;
      const payload = JSON.stringify({ conversationId: "c", fullyIdle: false, note: "a\tb" });
      assert.equal(run("Stop", { [ANTIGRAVITY_HOOK_EVENTS_ENV]: file }, `${payload}\n`), "");
      assert.equal(run("PreInvocation", { [ANTIGRAVITY_HOOK_EVENTS_ENV]: file }, "{}"), "");
      const lines = (yield* fs.readFileString(file)).split("\n");
      assert.equal(lines[0], `Stop\t${payload}`);
      assert.equal(lines[1], "PreInvocation\t{}");
      assert.equal(lines[2], "");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it("does nothing outside a T3 Code runtime", () => {
    assert.equal(run("Stop", {}, '{"conversationId":"c"}\n'), "");
  });
});

describe("hook events file", () => {
  it("decodes an event line and skips anything else", () => {
    const event = decodeAntigravityHookLine(
      `PostToolUse\t${JSON.stringify({
        conversationId: "c",
        stepIdx: 2,
        toolCall: { name: "run_command", args: { CommandLine: "ls" } },
        error: "",
        unrelated: true,
      })}`,
    );
    assert.deepEqual(event, {
      name: "PostToolUse",
      conversationId: "c",
      stepIdx: 2,
      toolCall: { name: "run_command", args: { CommandLine: "ls" } },
      error: "",
    });
    assert.isUndefined(decodeAntigravityHookLine("SessionStart\t{}"));
    assert.isUndefined(decodeAntigravityHookLine("Stop\t{broken"));
    assert.isUndefined(decodeAntigravityHookLine("Stop\t{}"));
    assert.isUndefined(decodeAntigravityHookLine("no tab"));
  });

  it("holds back a partial last line", () => {
    assert.deepEqual(takeCompleteLines("Stop\t{}\nPre"), { lines: ["Stop\t{}"], rest: "Pre" });
    assert.deepEqual(takeCompleteLines("Pre"), { lines: [], rest: "Pre" });
    assert.deepEqual(takeCompleteLines("a\n\nb\n"), { lines: ["a", "b"], rest: "" });
  });
});
