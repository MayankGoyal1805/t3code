import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import {
  antigravityGeminiDirectoryArgs,
  resolveAntigravityGeminiDirectory,
} from "./AntigravityHome.ts";

const instanceId = ProviderInstanceId.make("antigravity");

it.layer(NodeServices.layer)("AntigravityHome", (it) => {
  it.effect("shares ~/.gemini and passes no flag without a home path", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      expect(yield* resolveAntigravityGeminiDirectory({ homePath: "" })).toBe(
        path.join(NodeOS.homedir(), ".gemini"),
      );
      expect(yield* antigravityGeminiDirectoryArgs(instanceId, { homePath: "" })).toEqual([]);
    }),
  );

  it.effect("passes a home-relative --gemini-dir for a configured directory", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const expected = ["--gemini-dir", path.join(".gemini-work", "inner")];
      expect(
        yield* antigravityGeminiDirectoryArgs(instanceId, { homePath: "~/.gemini-work/inner" }),
      ).toEqual(expected);
      expect(
        yield* antigravityGeminiDirectoryArgs(instanceId, {
          homePath: path.join(NodeOS.homedir(), ".gemini-work", "inner"),
        }),
      ).toEqual(expected);
    }),
  );

  it.effect("rejects directories outside the home directory", () =>
    Effect.gen(function* () {
      for (const homePath of ["/tmp/agy-elsewhere", "~/..", "~"]) {
        const error = yield* Effect.flip(antigravityGeminiDirectoryArgs(instanceId, { homePath }));
        expect(error.detail).toContain("inside your home directory");
      }
    }),
  );
});
