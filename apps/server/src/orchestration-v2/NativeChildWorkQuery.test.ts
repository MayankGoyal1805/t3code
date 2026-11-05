import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as HostProcess from "@t3tools/shared/HostProcess";

import {
  CALL_ID,
  childSteps,
  launched,
  makeProfile,
  ROOT,
} from "../provider/acp/AntigravityChildWork.testkit.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as NativeChildWorkQuery from "./NativeChildWorkQuery.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const instanceId = ProviderInstanceId.make("antigravity");
const childThreadId = ThreadId.make("thread-child");

const records = (providerInstance: ProviderInstanceId) => ({
  thread: {
    id: childThreadId,
    creationSource: "provider",
    lineage: { parentThreadId: "thread-parent", relationshipToParent: "subagent" },
    forkedFrom: { type: "node", nodeId: "subagent-new" },
  },
  subagents: [
    {
      id: "subagent-new",
      childThreadId,
      driver: "antigravity",
      origin: "provider_native",
      providerInstanceId: instanceId,
      runId: "run-root",
      nativeTaskRef: { nativeId: CALL_ID },
    },
  ],
  runs: [{ id: "run-root", providerThreadId: "provider-root" }],
  providerThreads: [
    {
      id: "provider-root",
      providerInstanceId: providerInstance,
      nativeThreadRef: { nativeId: ROOT },
    },
  ],
});

const readChildren = (providerInstance: ProviderInstanceId, home: string) =>
  Effect.gen(function* () {
    const query = yield* NativeChildWorkQuery.NativeChildWorkQuery;
    return (yield* query.getNativeChildWork({ threadId: childThreadId })).children;
  }).pipe(
    Effect.provide(
      NativeChildWorkQuery.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            ServerSettings.ServerSettingsService.layerTest(),
            Layer.mock(ThreadManagement.ThreadManagementService)({
              getThreadRecords: () => Effect.succeed(records(providerInstance) as never),
            }),
          ),
        ),
      ),
    ),
    Effect.provideService(HostProcess.HomeDirectory, home),
  );

it.layer(NodeServices.layer)("NativeChildWorkQuery", (it) => {
  it.effect("reads the child of the subagent's own session", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "native-child-work-" });
      yield* makeProfile({
        profile: path.join(home, ".gemini"),
        steps: launched,
        child: { steps: childSteps },
      });
      const [child] = yield* readChildren(instanceId, home);
      expect(child?.steps?.at(-1)?.text).toBe("marker 4242 found");
      // A session from another provider instance has no claim on this instance's records.
      expect(yield* readChildren(ProviderInstanceId.make("other"), home)).toEqual([]);
    }),
  );
});
