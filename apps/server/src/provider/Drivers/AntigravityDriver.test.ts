import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  ANTIGRAVITY_DEFAULT_MODEL,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
  type AntigravitySettings,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { HttpClient } from "effect/http";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ModelManifest from "../ModelManifest.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { AntigravityDriver } from "./AntigravityDriver.ts";
import * as ProviderHostLive from "../ProviderHostLive.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";

const hostPlatform = HostProcess.Platform.defaultValue();
const windowsHost = hostPlatform === "win32";
const decodeRequest = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      method: Schema.optional(Schema.String),
      params: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    }),
  ),
);
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

const makeHarness = Effect.fn("makeAntigravityDriverHarness")(function* (
  options: {
    readonly config?: Partial<AntigravitySettings>;
    readonly enabled?: boolean;
    readonly signedOut?: boolean;
  } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const nodePath = yield* HostProcess.ExecutablePath;
  const baseEnv = yield* HostProcess.Environment;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-antigravity-driver-" });
  const instanceId = ProviderInstanceId.make(path.basename(root));
  const mockAgentPath = yield* path.fromFileUrl(
    new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
  );
  const requestLog = path.join(root, "requests.jsonl");

  // Stands in for `agy`: answers --version and otherwise serves ACP like the mock agent.
  const executablePath = path.join(root, "agy");
  yield* fs.writeFileString(
    executablePath,
    [
      "#!/bin/sh",
      'if [ "$1" = "--version" ]; then echo "1.5.1"; exit 0; fi',
      ...(options.signedOut === true ? ["export T3_ACP_REQUIRE_AUTH=1"] : []),
      `exec ${shellQuote(nodePath)} ${shellQuote(mockAgentPath)} "$@"`,
      "",
    ].join("\n"),
  );
  yield* fs.chmod(executablePath, 0o755);

  const launches: Array<{
    command: string;
    args: ReadonlyArray<string>;
    extendEnv: boolean | undefined;
    environment: Record<string, string | undefined>;
    cwd: string | undefined;
    handle: ChildProcessSpawner.ChildProcessHandle;
  }> = [];
  const observedSpawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (command._tag !== "StandardCommand")
        return yield* Effect.die("Unexpected process pipeline.");
      const handle = yield* spawner.spawn(command);
      launches.push({
        command: command.command,
        args: command.args.map(String),
        extendEnv: command.options.extendEnv,
        environment: Object.fromEntries(
          Object.entries(command.options.env ?? {}).map(([key, value]) => [
            key,
            Redacted.isRedacted(value) ? Redacted.value(value) : value,
          ]),
        ),
        cwd: command.options.cwd,
        handle,
      });
      return handle;
    }),
  );
  const instance = yield* AntigravityDriver.create({
    instanceId,
    displayName: "Google test account",
    enabled: options.enabled ?? true,
    config: {
      ...AntigravityDriver.defaultConfig(),
      binaryPath: executablePath,
      ...options.config,
    },
    environment: [
      { name: "PATH", value: baseEnv.PATH ?? "" },
      { name: "T3_ACP_ANTIGRAVITY", value: "1" },
      { name: "T3_ACP_REQUEST_LOG_PATH", value: requestLog },
      { name: "GOOGLE_APPLICATION_CREDENTIALS", value: "/user/adc.json" },
      { name: "ELECTRON_RUN_AS_NODE", value: "1" },
    ].map((variable) => ({ ...variable, sensitive: false })),
  }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, observedSpawner));
  const refresh = instance.refreshModels;
  if (!refresh) return yield* Effect.die("Antigravity does not expose model refresh.");
  const readRequests = Effect.gen(function* () {
    if (!(yield* fs.exists(requestLog))) return [];
    const text = yield* fs.readFileString(requestLog);
    return yield* Effect.forEach(text.split(/\r?\n/u).filter(Boolean), (line) =>
      decodeRequest(line),
    );
  });
  const assertClosed = Effect.gen(function* () {
    for (const launch of launches) {
      yield* launch.handle.exitCode.pipe(Effect.ignore);
      expect(yield* launch.handle.isRunning).toBe(false);
      if (launch.cwd && launch.args[0] === "acp") expect(yield* fs.exists(launch.cwd)).toBe(false);
    }
  });
  // The instance probes once on startup; settle it so each test sees only its own processes.
  yield* instance.snapshot.refresh;
  const startupRequests = (yield* readRequests).map((request) => request.method);
  launches.length = 0;
  yield* fs.remove(requestLog, { force: true });
  return {
    instance,
    refresh,
    executablePath,
    fs,
    launches,
    readRequests,
    startupRequests,
    assertClosed,
  };
});

const layerDeps = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-antigravity-driver-config-",
}).pipe(
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  Layer.provideMerge(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Unexpected quota request")),
    ),
  ),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(
    Layer.mock(BackgroundPolicy.BackgroundPolicy)({
      shouldRunScopeWork: () => Effect.succeed(false),
    }),
  ),
  Layer.provideMerge(
    Layer.succeed(
      ProviderEventLoggers.ProviderEventLoggers,
      ProviderEventLoggers.NoOpProviderEventLoggers,
    ),
  ),
  Layer.provideMerge(ModelManifest.layerTest),
  Layer.provideMerge(IdAllocator.layer),
  Layer.provideMerge(McpProviderSessions.layer),
);
const layerTest = ProviderHostLive.layer.pipe(
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provideMerge(layerDeps),
);

it.layer(layerTest)("AntigravityDriver", (it) => {
  it.effect.skipIf(windowsHost)("refreshes through `agy acp` with the user's environment", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.refresh();
      const snapshot = yield* h.instance.snapshot.getSnapshot;
      expect(snapshot.status).toBe("ready");
      expect(snapshot.auth.status).toBe("authenticated");
      expect(snapshot.models.map((model) => model.slug)).toEqual([
        "gemini-test-low",
        "gemini-test-high",
      ]);
      expect(snapshot.models[0]?.aliases).toContain(ANTIGRAVITY_DEFAULT_MODEL);
      expect(snapshot.slashCommands.map((command) => command.name)).toEqual(["plan", "logout"]);

      const acpLaunches = h.launches.filter((launch) => launch.args[0] === "acp");
      expect(acpLaunches.length).toBeGreaterThan(0);
      for (const launch of acpLaunches) {
        expect(launch.command).toBe(h.executablePath);
        expect(launch.args).toEqual(["acp"]);
        expect(launch.extendEnv).toBe(false);
        // The user's own credentials reach agy; only the Electron-as-Node switch is dropped.
        expect(launch.environment.GOOGLE_APPLICATION_CREDENTIALS).toBe("/user/adc.json");
        expect(launch.environment.ELECTRON_RUN_AS_NODE).toBeUndefined();
        expect(launch.environment.GEMINI_HOME).toBeUndefined();
      }
      const requests = yield* h.readRequests;
      // A Google-account session never authenticates unattended: agy would open a browser.
      expect(requests.map((request) => request.method)).toEqual(["initialize", "session/new"]);
      expect(requests[1]?.params?.mcpServers).toEqual([]);
      yield* h.assertClosed;
    }).pipe(Effect.scoped),
  );

  it.effect.skipIf(windowsHost)("reports sign-in, plan, and models from a throwaway session", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const snapshot = yield* h.instance.snapshot.getSnapshot;
      expect(snapshot).toMatchObject({
        installed: true,
        status: "ready",
        auth: { status: "authenticated", type: "oauth-personal", label: "Google AI Pro" },
      });
      expect(snapshot.models.map((model) => model.slug)).toEqual([
        "gemini-test-low",
        "gemini-test-high",
      ]);
      expect(h.startupRequests.slice(0, 2)).toEqual(["initialize", "session/new"]);
      yield* h.assertClosed;
    }).pipe(Effect.scoped),
  );

  it.effect.skipIf(windowsHost)("reports a signed-out account from the health check", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ signedOut: true });
      expect(yield* h.instance.snapshot.getSnapshot).toMatchObject({
        installed: true,
        status: "warning",
        auth: { status: "unauthenticated" },
        message: "Sign in with Google to use Antigravity.",
        models: [],
      });
      yield* h.assertClosed;
    }).pipe(Effect.scoped),
  );

  it.effect.skipIf(windowsHost)(
    "starts an instance with its own home in --gemini-dir relative to HOME",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness({ config: { homePath: "~/.t3-agy-driver-test/gemini" } });
        yield* h.refresh();
        const launch = h.launches.find((candidate) => candidate.args[0] === "acp");
        expect(launch?.args).toEqual(["acp", "--gemini-dir", ".t3-agy-driver-test/gemini"]);
      }).pipe(Effect.scoped),
  );

  it.effect.skipIf(windowsHost)("refuses a home outside the user's home directory", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ config: { homePath: "/tmp/agy-elsewhere" } });
      const error = yield* h.refresh().pipe(Effect.flip);
      expect(error.detail).toContain("inside your home directory");
      expect(h.launches.filter((launch) => launch.args[0] === "acp")).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect.skipIf(windowsHost)(
    "closes refresh processes and clears account metadata when Google sign-in is required",
    () =>
      Effect.gen(function* () {
        const ready = yield* makeHarness();
        yield* ready.refresh();
        const h = yield* makeHarness({ signedOut: true });
        const error = yield* h.refresh().pipe(Effect.flip);
        expect(error.detail).toContain("Sign in to Antigravity");
        const snapshot = yield* h.instance.snapshot.getSnapshot;
        expect(snapshot.auth.status).toBe("unauthenticated");
        expect(snapshot.models).toEqual([]);
        expect(snapshot.slashCommands).toEqual([]);
        expect(snapshot.supportsTextGeneration).toBe(false);
        yield* h.assertClosed;
      }).pipe(Effect.scoped),
  );

  it.effect.skipIf(windowsHost)("keeps the previous catalog when agy cannot be started", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.refresh();
      const before = yield* h.instance.snapshot.getSnapshot;
      const missing = yield* makeHarness({ config: { binaryPath: "/nonexistent/agy" } });
      const error = yield* missing.refresh().pipe(Effect.flip);
      expect(error.detail).toContain("previous model list is unchanged");
      expect(yield* h.instance.snapshot.getSnapshot).toEqual(before);
    }).pipe(Effect.scoped),
  );

  it.effect.skipIf(windowsHost)(
    "offers form questions to chat sessions only and sets agy's own permission modes",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        yield* h.refresh();
        const workspace = yield* h.fs.makeTempDirectoryScoped({ prefix: "t3-ag-chat-" });
        const modelSelection = { instanceId: h.instance.instanceId, model: "gemini-test-low" };
        const open = Effect.fn("AntigravityDriverTest.openChat")(function* (
          runtimeMode: "approval-required" | "auto-accept-edits" | "full-access",
        ) {
          const threadId = ThreadId.make(`thread-antigravity-${runtimeMode}`);
          const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
            runtimeMode,
            interactionMode: "default",
            cwd: workspace,
          });
          const session = yield* h.instance.orchestrationAdapter.openSession({
            threadId,
            providerSessionId: ProviderSessionId.make(`provider-session-${runtimeMode}`),
            modelSelection,
            runtimePolicy,
          });
          yield* session.ensureThread({ threadId, modelSelection, runtimePolicy });
        });
        const modesSet = Effect.map(h.readRequests, (requests) =>
          requests
            .filter(
              (request) =>
                request.method === "session/set_config_option" &&
                request.params?.configId === "mode",
            )
            .map((request) => request.params?.value),
        );
        yield* open("approval-required");
        expect(yield* modesSet).toEqual([]);
        yield* open("full-access");
        yield* open("auto-accept-edits");
        expect(yield* modesSet).toEqual(["accept-edits", "accept-edits"]);
        const capabilities = (yield* h.readRequests)
          .filter((request) => request.method === "initialize")
          .map((request) => request.params?.clientCapabilities);
        expect(capabilities.at(0)).toMatchObject({ terminal: false });
        expect(capabilities.at(-1)).toMatchObject({
          fs: { readTextFile: false, writeTextFile: false },
          elicitation: { form: {} },
        });
        // Opened sessions register agy hooks in the Gemini directory, which must not be the real ~/.gemini.
      }).pipe(
        Effect.provideServiceEffect(
          HostProcess.HomeDirectory,
          FileSystem.FileSystem.pipe(
            Effect.flatMap((fs) => fs.makeTempDirectoryScoped({ prefix: "t3-antigravity-home-" })),
          ),
        ),
        Effect.scoped,
      ),
  );
});
