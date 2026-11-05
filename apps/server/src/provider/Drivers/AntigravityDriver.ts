import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { AntigravitySettings, ProviderDriverKind, ProviderSetupError } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { HttpClient } from "effect/http";
import type { AcpError } from "effect-acp/errors";

import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import {
  isAntigravityTextGenerationAvailable,
  makeAntigravityTextGeneration,
} from "../../textGeneration/AntigravityTextGeneration.ts";
import { makeAntigravityAuth, type AntigravityAuth } from "../AntigravityAuth.ts";
import * as AntigravityUsage from "./AntigravityUsage.ts";
import {
  antigravityAuthConfigIssue,
  antigravityAuthLabel,
  antigravityAuthUsesBrowser,
  buildAntigravityAcpSpawnInput,
  isAntigravitySignInRequiredError,
  watchAntigravityAuthorizationUrl,
  writeAntigravityBrowserCapture,
  type AntigravityAuthConfig,
} from "../antigravityAuthSupport.ts";
import {
  antigravityModelsToProbeForThinking,
  makeAntigravityAcpRuntime,
  type AntigravityAcpRuntimeInput,
} from "../acp/AntigravityAcpSupport.ts";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import type { ServerProviderDraft } from "@t3tools/provider-core/server/snapshotProbe";
import {
  antigravityGeminiDirectoryArgs,
  removeAntigravityConversation,
  resolveAntigravityGeminiDirectory,
} from "./AntigravityHome.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import { makeAntigravityAdapterV2 } from "../../orchestration-v2/Adapters/AntigravityAdapterV2.ts";
import { makeAcpNativeLoggerFactory } from "@t3tools/provider-acp/server/nativeLogging";
import { ProviderDriverError } from "../Errors.ts";
import { makeAntigravityProvider, type AntigravityProbeResult } from "../AntigravityProvider.ts";
import { makeAntigravityUsageProbe } from "../antigravityUsageLimits.ts";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import {
  makeCachedProviderMaintenanceResolution,
  makeManualOnlyProviderMaintenanceCapabilities,
  makeProviderMaintenanceCapabilities,
  resolveProviderMaintenanceCapabilitiesEffect,
  type ProviderMaintenanceCapabilitiesResolver,
} from "@t3tools/provider-core/server/maintenanceResolver";
import * as ModelCatalog from "@t3tools/provider-core/server/ModelCatalog";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import { discoverAntigravitySkills } from "./AntigravitySkills.ts";

const DRIVER = ProviderDriverKind.make("antigravity");
const decodeSettings = Schema.decodeSync(AntigravitySettings);

// `agy update` replaces the binary in place, wherever the user installed it.
const UPDATE: ProviderMaintenanceCapabilitiesResolver = {
  resolve: (context) =>
    Effect.succeed(
      context
        ? makeProviderMaintenanceCapabilities({
            provider: DRIVER,
            packageName: null,
            updateExecutable: context.resolvedCommandPath,
            updateArgs: ["update"],
            updateLockKey: "antigravity",
            platform: context.platform,
            env: context.env,
          })
        : makeManualOnlyProviderMaintenanceCapabilities({ provider: DRIVER, packageName: null }),
    ),
};

export type AntigravityDriverEnv =
  | ProviderHost.ProviderHost
  | ChildProcessSpawner.ChildProcessSpawner
  | Digest.Digest
  | SecureRandom.SecureRandom
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | IdAllocator.IdAllocatorV2
  | McpProviderSessions.McpProviderSessions
  | ModelCatalog.ModelCatalog
  | Path.Path
  | ProviderEventLoggers.ProviderEventLoggers;

export const AntigravityDriver: ProviderDriver<
  AntigravitySettings,
  AntigravityDriverEnv,
  AntigravityUsage.AntigravityUsage
> = {
  driverKind: DRIVER,
  metadata: { displayName: "Antigravity", supportsMultipleInstances: true },
  configSchema: AntigravitySettings,
  defaultConfig: () => decodeSettings({}),
  usage: AntigravityUsage.antigravityUsageReader,
  create: Effect.fn("AntigravityDriver.create")(function* ({
    instanceId,
    displayName,
    accentColor,
    environment,
    enabled,
    config,
  }) {
    const digest = yield* Digest.Digest;
    const random = yield* SecureRandom.SecureRandom;
    const fileSystem = yield* FileSystem.FileSystem;
    const httpClient = yield* HttpClient.HttpClient;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const selfInvocation = yield* resolveSelfInvocation();
    const loggers = yield* ProviderEventLoggers.ProviderEventLoggers;
    const modelCatalog = yield* ModelCatalog.ModelCatalog;
    const currentCatalog = modelCatalog.current(DRIVER);
    const continuationRequests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
    const makeNativeLogger = yield* makeAcpNativeLoggerFactory();
    const settings = { ...config, enabled } satisfies AntigravitySettings;
    const auth: AntigravityAuthConfig = {
      authMethod: settings.authMethod,
      apiKey: settings.apiKey,
      gcpProject: settings.gcpProject,
      gcpLocation: settings.gcpLocation,
    };
    const authConfigIssue = antigravityAuthConfigIssue(auth);
    const processEnvironment = yield* mergeProviderInstanceEnvironment(environment);
    const geminiDirectory = yield* resolveAntigravityGeminiDirectory(settings).pipe(
      Effect.provideService(Path.Path, path),
    );
    const platform = yield* HostProcess.Platform;
    const resolveMaintenance = yield* makeCachedProviderMaintenanceResolution(
      resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
        binaryPath: settings.binaryPath,
        env: processEnvironment,
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      ),
    );
    const continuationIdentity = defaultProviderContinuationIdentity({
      driverKind: DRIVER,
      instanceId,
    });
    const stampIdentity = withInstanceIdentity({
      instanceId,
      driverKind: DRIVER,
      displayName,
      accentColor,
      continuationGroupKey: continuationIdentity.continuationKey,
    });
    const classifyModels = (draft: ServerProviderDraft) =>
      currentCatalog.pipe(
        Effect.map((catalog) => stampIdentity(ModelCatalog.applyModelCatalog(draft, catalog))),
      );

    const makeRuntime = Effect.fn("AntigravityDriver.makeRuntime")(function* (
      input: Omit<AntigravityAcpRuntimeInput, "spawn" | "childProcessSpawner"> & {
        /** A probe reports a signed-out account in its result, not through the account state. */
        readonly silentAuthRequired?: boolean;
      },
    ): Effect.fn.Return<
      AcpSessionRuntime.AcpSessionRuntime["Service"],
      AcpError | ProviderSetupError,
      Scope.Scope
    > {
      if (authConfigIssue !== null) {
        return yield* new ProviderSetupError({
          instanceId,
          operation: "configure",
          detail: authConfigIssue,
        });
      }
      const geminiDirectoryArgs = yield* antigravityGeminiDirectoryArgs(instanceId, settings).pipe(
        Effect.provideService(Path.Path, path),
      );
      // agy discards a sign-in helper's output, so the browser stand-in hands the URL over in a file.
      const browserCapture =
        input.onAuthorizationUrl !== undefined && platform !== "win32"
          ? yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-antigravity-signin-" }).pipe(
              Effect.flatMap((directory) =>
                writeAntigravityBrowserCapture(directory).pipe(
                  Effect.map((target) => ({ directory, target })),
                ),
              ),
              Effect.provideService(FileSystem.FileSystem, fileSystem),
              Effect.provideService(Path.Path, path),
              Effect.mapError(
                (cause) =>
                  new ProviderSetupError({
                    instanceId,
                    operation: "start",
                    detail: "Could not prepare Antigravity sign-in.",
                    cause,
                  }),
              ),
            )
          : undefined;
      if (browserCapture !== undefined && input.onAuthorizationUrl !== undefined) {
        yield* watchAntigravityAuthorizationUrl(
          browserCapture.target,
          input.onAuthorizationUrl,
        ).pipe(Effect.provideService(FileSystem.FileSystem, fileSystem), Effect.forkScoped);
      }
      const runtime = yield* makeAntigravityAcpRuntime({
        ...input,
        authMethod: auth.authMethod,
        childProcessSpawner: spawner,
        spawn: buildAntigravityAcpSpawnInput({
          executablePath: settings.binaryPath,
          geminiDirectoryArgs,
          cwd: input.cwd,
          baseEnv: processEnvironment,
          auth,
          platform,
          ...(browserCapture === undefined
            ? {}
            : { browserCaptureDirectory: browserCapture.directory }),
        }),
      }).pipe(Effect.provideService(SecureRandom.SecureRandom, random));
      return {
        ...runtime,
        start: () =>
          runtime
            .start()
            .pipe(
              Effect.tapError((cause): Effect.Effect<void> =>
                input.onAuthorizationUrl === undefined &&
                input.silentAuthRequired !== true &&
                isAntigravitySignInRequiredError(cause)
                  ? provider.onAuthRequired
                  : Effect.void,
              ),
            ),
      };
    });

    const makeDisposableRuntime = Effect.fn("AntigravityDriver.makeDisposableRuntime")(function* (
      input: Pick<AntigravityAcpRuntimeInput, "onAuthorizationUrl"> & {
        readonly silentAuthRequired?: boolean;
      },
    ) {
      const cwd = yield* fileSystem
        .makeTempDirectoryScoped({ prefix: "t3-antigravity-setup-" })
        .pipe(
          Effect.mapError(
            () =>
              new ProviderSetupError({
                instanceId,
                operation: "start",
                detail: "Could not create an Antigravity setup workspace.",
              }),
          ),
        );
      let sessionId: string | undefined;
      yield* Effect.addFinalizer(() =>
        removeAntigravityConversation(geminiDirectory, sessionId).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        ),
      );
      const runtime = yield* makeRuntime({
        cwd,
        mcpServers: [],
        ...(input.onAuthorizationUrl ? { onAuthorizationUrl: input.onAuthorizationUrl } : {}),
        ...(input.silentAuthRequired ? { silentAuthRequired: true } : {}),
        // The conversation exists as soon as session/new answers, even if the rest of start fails.
        requestLogger: (event) =>
          Effect.sync(() => {
            const created =
              event.method === "session/new" && event.status === "succeeded"
                ? Predicate.isObject(event.result)
                  ? event.result.sessionId
                  : undefined
                : undefined;
            if (typeof created === "string") sessionId = created;
          }),
      });
      return runtime;
    });

    const publishCatalog = Effect.fn("AntigravityDriver.publishCatalog")(function* (
      started: AcpSessionRuntime.AcpSessionRuntimeStartResult,
      runtime: Pick<
        AcpSessionRuntime.AcpSessionRuntime["Service"],
        "getEvents" | "drainEvents" | "setModel"
      >,
      force = false,
    ): Effect.fn.Return<void, never, Scope.Scope> {
      yield* provider.onSessionStarted(started);
      yield* Stream.runForEach(runtime.getEvents(), (event) => {
        if (event._tag === "EventStreamBarrier") {
          return Deferred.succeed(event.acknowledge, undefined).pipe(Effect.asVoid);
        }
        if (event._tag === "ConfigOptionsUpdated") {
          return provider.onConfigOptionsUpdated(event.configOptions);
        }
        return event._tag === "AvailableCommandsUpdated"
          ? provider.onAvailableCommands(event.availableCommands)
          : Effect.void;
      }).pipe(Effect.forkScoped);
      // Thinking levels differ per model and are reported only for the selected one.
      const known = (model: string) => provider.hasThinkingLevels(model);
      for (const model of antigravityModelsToProbeForThinking(
        started.sessionSetupResult.configOptions ?? [],
        force ? () => false : known,
      )) {
        yield* runtime.setModel(model).pipe(Effect.ignore);
      }
      yield* runtime.drainEvents;
    }, Effect.scoped);

    const authFlow: AntigravityAuth = yield* makeAntigravityAuth({
      instanceId,
      makeRuntime: makeDisposableRuntime,
      // A new sign-in may be another account; drop any in-flight quota read first.
      onAuthenticated: (started, runtime) =>
        Effect.suspend(() => provider.onSignedIn).pipe(
          Effect.andThen(publishCatalog(started, runtime)),
        ),
      onSignedOut: Effect.suspend(() => provider.onSignedOut),
      usesBrowser: antigravityAuthUsesBrowser(auth.authMethod),
    });

    // One throwaway session reads sign-in state, plan, and models; agy answers it in milliseconds.
    const probe = Effect.fn("AntigravityDriver.probe")(function* (): Effect.fn.Return<
      AntigravityProbeResult,
      AcpError | ProviderSetupError
    > {
      yield* modelCatalog.refreshInBackground;
      if (authConfigIssue !== null) {
        return yield* new ProviderSetupError({
          instanceId,
          operation: "configure",
          detail: authConfigIssue,
        });
      }
      return yield* Effect.gen(function* () {
        const runtime = yield* makeDisposableRuntime({ silentAuthRequired: true });
        const initialize = yield* runtime.initialize();
        return yield* runtime.start().pipe(
          Effect.flatMap((started) => publishCatalog(started, runtime)),
          Effect.as({ initialize }),
          Effect.catchIf(isAntigravitySignInRequiredError, () =>
            Effect.succeed({ initialize, authRequired: true }),
          ),
        );
      }).pipe(Effect.scoped);
    });

    const usage = yield* makeAntigravityUsageProbe({
      profileDirectory: geminiDirectory,
      authMethod: auth.authMethod,
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(Digest.Digest, digest),
      Effect.provideService(HttpClient.HttpClient, httpClient),
    );
    const provider = yield* makeAntigravityProvider(settings, {
      stampIdentity: classifyModels,
      resolveMaintenance,
      probe: probe(),
      probeUsage: usage.probe,
      clearUsage: usage.clear,
      auth: { type: auth.authMethod, label: antigravityAuthLabel(auth.authMethod) },
      supportsTextGeneration: isAntigravityTextGenerationAvailable(geminiDirectory).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.orElseSucceed(() => false),
      ),
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER,
            instanceId,
            detail: "Could not prepare the Antigravity provider status.",
            cause,
          }),
      ),
    );
    const defaultModel = currentCatalog.pipe(Effect.map((catalog) => catalog?.defaultChatModel));
    const orchestrationAdapter = yield* makeAntigravityAdapterV2({
      instanceId,
      selfInvocation,
      makeRuntime,
      withProcess: authFlow.withProcess,
      defaultModel,
      version: provider.snapshot.getSnapshot.pipe(
        Effect.map((snapshot) => snapshot.version ?? undefined),
      ),
      profileDirectory: geminiDirectory,
      onSessionStarted: provider.onSessionStarted,
      onSessionEvent: (event) => {
        if (event._tag === "ConfigOptionsUpdated") {
          return provider.onConfigOptionsUpdated(event.configOptions);
        }
        return event._tag === "AvailableCommandsUpdated"
          ? provider.onAvailableCommands(event.availableCommands)
          : Effect.void;
      },
      continuationRequests,
      nativeLogging: (threadId) =>
        makeNativeLogger({
          nativeEventLogger: loggers.native,
          provider: DRIVER,
          threadId,
        }),
    });
    const textGeneration = yield* makeAntigravityTextGeneration({
      profileDirectory: geminiDirectory,
      defaultModel,
      withProcess: authFlow.withProcess,
      makeRuntime: (cwd) =>
        makeRuntime({
          cwd,
          mcpServers: [],
        }),
    });

    const refreshModels = Effect.fn("AntigravityDriver.refreshModels")(
      function* () {
        const processScope = yield* Scope.make();
        yield* Effect.addFinalizer((exit) => Scope.close(processScope, exit));
        yield* authFlow
          .withProcess(
            Scope.close(processScope, Exit.void),
            Effect.gen(function* () {
              const runtime = yield* makeDisposableRuntime({});
              const started = yield* runtime.start();
              yield* publishCatalog(started, runtime, true);
            }),
          )
          .pipe(Effect.provideService(Scope.Scope, processScope));
      },
      Effect.scoped,
      Effect.timeoutOrElse({
        duration: "90 seconds",
        orElse: () =>
          Effect.fail(
            new ProviderDriverError({
              driver: DRIVER,
              instanceId,
              detail: "Antigravity model refresh timed out. Try again or check Google sign-in.",
            }),
          ),
      }),
      Effect.tapError((cause) =>
        isAntigravitySignInRequiredError(cause) ? provider.onAuthRequired : Effect.void,
      ),
      Effect.mapError((cause) =>
        cause._tag === "ProviderDriverError"
          ? cause
          : new ProviderDriverError({
              driver: DRIVER,
              instanceId,
              detail: isAntigravitySignInRequiredError(cause)
                ? "Sign in to Antigravity in provider settings before refreshing models."
                : cause._tag === "ProviderSetupError" &&
                    (cause.operation === "configure" || cause.operation === "start")
                  ? cause.detail
                  : "Could not refresh Antigravity models. The previous model list is unchanged.",
              cause,
            }),
      ),
    );

    return {
      instanceId,
      driverKind: DRIVER,
      continuationIdentity,
      displayName,
      accentColor,
      enabled,
      snapshot: provider.snapshot,
      snapshotForCwd: (cwd) =>
        !enabled
          ? provider.snapshot.getSnapshot
          : discoverAntigravitySkills({ cwd, geminiDirectory }).pipe(
              Effect.provideService(FileSystem.FileSystem, fileSystem),
              Effect.provideService(Path.Path, path),
              Effect.flatMap((skills) => provider.snapshotForCwd(cwd, skills)),
              Effect.mapError(
                (cause) =>
                  new ProviderDriverError({
                    driver: DRIVER,
                    instanceId,
                    detail: "Could not read Antigravity workspace skills.",
                    cause,
                  }),
              ),
            ),
      orchestrationAdapter,
      textGeneration,
      auth: authFlow.controller,
      refreshModels,
    } satisfies ProviderInstance;
  }),
};
