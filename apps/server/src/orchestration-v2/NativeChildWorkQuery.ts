import {
  AntigravitySettings,
  isProviderNativeSubagentThread,
  OrchestrationV2GetNativeChildWorkError,
  type OrchestrationV2GetNativeChildWorkInput,
  type OrchestrationV2GetNativeChildWorkResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { readAntigravityChildWork } from "../provider/acp/AntigravityChildWork.ts";
import { resolveAntigravityGeminiDirectory } from "../provider/Drivers/AntigravityHome.ts";
import { deriveProviderInstanceConfigMap } from "../provider/ProviderInstanceRegistryHydration.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

/** Reads what a provider-native subagent's children did, on demand. Other providers stream real child sessions. */
export class NativeChildWorkQuery extends Context.Service<
  NativeChildWorkQuery,
  {
    readonly getNativeChildWork: (
      input: OrchestrationV2GetNativeChildWorkInput,
    ) => Effect.Effect<
      OrchestrationV2GetNativeChildWorkResult,
      OrchestrationV2GetNativeChildWorkError
    >;
  }
>()("t3/orchestration-v2/NativeChildWorkQuery") {}

const decodeAntigravitySettings = Schema.decodeUnknownOption(AntigravitySettings);
const NO_CHILDREN: OrchestrationV2GetNativeChildWorkResult = { children: [] };

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const settings = yield* ServerSettings.ServerSettingsService;
  const path = yield* Path.Path;

  const getNativeChildWork = Effect.fn("NativeChildWorkQuery.getNativeChildWork")(
    function* (input: OrchestrationV2GetNativeChildWorkInput) {
      const { thread } = yield* threads.getThreadRecords(input.threadId, []);
      const parentThreadId = thread.lineage.parentThreadId;
      if (
        !isProviderNativeSubagentThread(thread) ||
        parentThreadId === null ||
        thread.forkedFrom?.type !== "node"
      ) {
        return NO_CHILDREN;
      }
      const subagentId = thread.forkedFrom.nodeId;
      const { subagents } = yield* threads.getThreadRecords(parentThreadId, ["subagents"]);
      const subagent = subagents.find(
        (candidate) => candidate.id === subagentId && candidate.childThreadId === thread.id,
      );
      const nativeTaskId = subagent?.nativeTaskRef?.nativeId;
      if (
        subagent?.driver !== "antigravity" ||
        subagent.origin !== "provider_native" ||
        subagent.runId === null ||
        !nativeTaskId
      ) {
        return NO_CHILDREN;
      }
      const { runs, providerThreads } = yield* threads.getThreadRecords(
        parentThreadId,
        ["runs", "providerThreads"],
        { runIds: [subagent.runId] },
      );
      const providerThreadId = runs.find((run) => run.id === subagent.runId)?.providerThreadId;
      const providerThread = providerThreads.find((candidate) => candidate.id === providerThreadId);
      const rootSessionId = providerThread?.nativeThreadRef?.nativeId;
      if (!rootSessionId || providerThread?.providerInstanceId !== subagent.providerInstanceId) {
        return NO_CHILDREN;
      }
      const config = deriveProviderInstanceConfigMap(yield* settings.getSettings)[
        subagent.providerInstanceId
      ]?.config;
      const geminiDirectory = yield* resolveAntigravityGeminiDirectory(
        Option.getOrElse(decodeAntigravitySettings(config ?? {}), () => ({ homePath: "" })),
      ).pipe(Effect.provideService(Path.Path, path));
      const children = yield* readAntigravityChildWork({
        profileDirectory: geminiDirectory,
        rootSessionId,
        nativeTaskId,
      });
      return { children };
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new OrchestrationV2GetNativeChildWorkError({ threadId: input.threadId, cause }),
        ),
      ),
  );

  return NativeChildWorkQuery.of({ getNativeChildWork });
});

export const layer = Layer.effect(NativeChildWorkQuery, make);
