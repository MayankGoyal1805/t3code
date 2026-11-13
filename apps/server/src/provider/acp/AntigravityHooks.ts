import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/**
 * ACP v1 has no agent-initiated turns and agy reports nothing when a background command or timer
 * ends. agy's documented hooks are the push signal: T3 Code registers one entry that appends each
 * hook payload to a file only T3 Code sets up, and does nothing in any other agy process.
 */
export const ANTIGRAVITY_HOOK_NAME = "t3-code";
export const ANTIGRAVITY_HOOK_EVENTS_ENV = "T3CODE_AGY_HOOK_EVENTS";

const HOOK_EVENTS = ["PreInvocation", "PreToolUse", "PostToolUse", "Stop"] as const;

/**
 * Hook stdout is interpreted by agy and a failing hook must not fail a turn, so this prints
 * nothing and always exits 0. The line is built first and written once, so concurrent hooks
 * (a subagent runs hooks too) do not interleave.
 */
const hookCommand = (event: (typeof HOOK_EVENTS)[number]) =>
  `sh -c '[ -n "$${ANTIGRAVITY_HOOK_EVENTS_ENV}" ] || { cat >/dev/null; exit 0; }; ` +
  `l=$(cat | tr -d "\\r\\n"); ` +
  `printf "%s\\t%s\\n" "$0" "$l" >> "$${ANTIGRAVITY_HOOK_EVENTS_ENV}" 2>/dev/null; exit 0' ${event}`;

const desiredEntry = () => ({
  PreInvocation: [{ command: hookCommand("PreInvocation") }],
  PreToolUse: [{ matcher: "*", hooks: [{ command: hookCommand("PreToolUse"), timeout: 10 }] }],
  PostToolUse: [{ matcher: "*", hooks: [{ command: hookCommand("PostToolUse"), timeout: 10 }] }],
  Stop: [{ command: hookCommand("Stop") }],
});

type JsonObject = Record<string, unknown>;

const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export type AntigravityHooksMerge =
  | { readonly _tag: "Write"; readonly text: string }
  | { readonly _tag: "Unchanged" }
  | { readonly _tag: "Invalid" };

/** Adds or refreshes the `t3-code` entry and keeps every other key as it was. */
export function mergeAntigravityHooksConfig(existing: string | undefined): AntigravityHooksMerge {
  let configuration: JsonObject = {};
  if (existing !== undefined && existing.trim().length > 0) {
    try {
      const parsed: unknown = JSON.parse(existing);
      if (!isJsonObject(parsed)) return { _tag: "Invalid" };
      configuration = parsed;
    } catch {
      return { _tag: "Invalid" };
    }
  }
  const entry = desiredEntry();
  if (JSON.stringify(configuration[ANTIGRAVITY_HOOK_NAME]) === JSON.stringify(entry)) {
    return { _tag: "Unchanged" };
  }
  return {
    _tag: "Write",
    text: `${JSON.stringify({ ...configuration, [ANTIGRAVITY_HOOK_NAME]: entry }, null, 2)}\n`,
  };
}

/** A hooks configuration without T3 Code's own entry, for checks that care about the user's hooks. */
export function withoutAntigravityHook(configuration: JsonObject): JsonObject {
  const { [ANTIGRAVITY_HOOK_NAME]: _ours, ...rest } = configuration;
  return rest;
}

export const antigravityHooksConfigPath = (path: Path.Path, geminiDirectory: string) =>
  path.join(geminiDirectory, "config", "hooks.json");

/**
 * Registers T3 Code's hooks in the profile's user-level `hooks.json`. Returns whether they are in
 * place; any problem leaves the file alone and the feature off, so a turn never depends on it.
 */
export const ensureAntigravityHooks = Effect.fn("ensureAntigravityHooks")(function* (
  geminiDirectory: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const target = antigravityHooksConfigPath(path, geminiDirectory);
  const install = Effect.gen(function* () {
    const existing = (yield* fs.exists(target)) ? yield* fs.readFileString(target) : undefined;
    const merged = mergeAntigravityHooksConfig(existing);
    if (merged._tag === "Invalid") {
      yield* Effect.logWarning(
        "Antigravity hooks.json is not a JSON object; background work will not be followed.",
        { target },
      );
      return false;
    }
    if (merged._tag === "Unchanged") return true;
    yield* fs.makeDirectory(path.dirname(target), { recursive: true });
    // The scratch directory goes with the scope on every path, so no temp entry outlives this.
    yield* Effect.scoped(
      Effect.gen(function* () {
        const scratch = yield* fs.makeTempDirectoryScoped({
          directory: path.dirname(target),
          prefix: ".hooks-",
        });
        const temporary = path.join(scratch, "hooks.json");
        yield* fs.writeFileString(temporary, merged.text);
        yield* fs.rename(temporary, target);
      }),
    );
    return true;
  });
  return yield* install.pipe(
    Effect.catch((cause) =>
      Effect.logWarning(
        "Could not register Antigravity hooks; background work will not be followed.",
        {
          target,
          cause,
        },
      ).pipe(Effect.as(false)),
    ),
  );
});
