import type { AntigravitySettings, ProviderInstanceId } from "@t3tools/contracts";
import { ProviderSetupError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";

/** The directory that holds `antigravity-cli/`: the instance's `homePath`, else the user's `~/.gemini`. */
export const resolveAntigravityGeminiDirectory = Effect.fn("resolveAntigravityGeminiDirectory")(
  function* (
    config: Pick<AntigravitySettings, "homePath">,
  ): Effect.fn.Return<string, never, Path.Path> {
    const path = yield* Path.Path;
    const home = yield* HostProcess.HomeDirectory;
    const homePath = config.homePath.trim();
    return path.resolve(
      homePath.length > 0 ? expandHomePath(homePath, home) : path.join(home, ".gemini"),
    );
  },
);

/**
 * `agy acp --gemini-dir` takes a path relative to `$HOME`; an absolute path is rejected.
 * The default instance passes nothing and lets agy use `~/.gemini`.
 */
export const antigravityGeminiDirectoryArgs = Effect.fn("antigravityGeminiDirectoryArgs")(
  function* (
    instanceId: ProviderInstanceId,
    config: Pick<AntigravitySettings, "homePath">,
  ): Effect.fn.Return<ReadonlyArray<string>, ProviderSetupError, Path.Path> {
    if (config.homePath.trim().length === 0) return [];
    const path = yield* Path.Path;
    const home = yield* HostProcess.HomeDirectory;
    const directory = yield* resolveAntigravityGeminiDirectory(config);
    const relative = path.relative(path.resolve(home), directory);
    if (
      relative.length === 0 ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      return yield* new ProviderSetupError({
        instanceId,
        operation: "configure",
        detail: "The Antigravity Gemini directory must be inside your home directory.",
      });
    }
    return ["--gemini-dir", relative];
  },
);

const isConversationId = Schema.is(Schema.String.check(Schema.isUUID()));

const conversationBase = (path: Path.Path, geminiDirectory: string, sessionId: string) =>
  path.join(geminiDirectory, "antigravity-cli", "conversations", sessionId);

/** agy accepts any id in `session/load` and answers with an empty session, so check the store first. */
export const antigravityConversationExists = Effect.fn("antigravityConversationExists")(function* (
  geminiDirectory: string,
  sessionId: string,
) {
  if (!isConversationId(sessionId)) return false;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* fs
    .exists(`${conversationBase(path, geminiDirectory, sessionId)}.db`)
    .pipe(Effect.orElseSucceed(() => false));
});

/** For helper sessions T3 Code opened in a temporary directory; they must not fill the user's history. */
export const removeAntigravityConversation = Effect.fn("removeAntigravityConversation")(
  function* (geminiDirectory: string, sessionId: string | undefined) {
    if (sessionId === undefined || !isConversationId(sessionId)) return;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const base = conversationBase(path, geminiDirectory, sessionId);
    for (const suffix of [".db", ".db-wal", ".db-shm", ".db-journal"]) {
      yield* fs.remove(`${base}${suffix}`, { force: true });
    }
    yield* fs.remove(path.join(geminiDirectory, "antigravity-cli", "brain", sessionId), {
      recursive: true,
      force: true,
    });
  },
  Effect.catch(() => Effect.logWarning("Could not remove temporary Antigravity session files.")),
);
