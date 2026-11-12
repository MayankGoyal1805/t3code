import { assert, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import { validateAntigravityCallbackUrl } from "./antigravityCallback.ts";

const instanceId = ProviderInstanceId.make("antigravity-callback-test");
const pending = { redirectUri: "http://localhost:51234/auth/callback", state: "owned-state" };

it.effect("accepts the exact owned Google callback and an explicit Google denial", () =>
  Effect.gen(function* () {
    for (const response of ["code=example-code", "error=access_denied"]) {
      const callback = `http://localhost:51234/auth/callback?state=owned-state&${response}&iss=https%3A%2F%2Faccounts.google.com`;
      const parsed = yield* validateAntigravityCallbackUrl(instanceId, pending, callback);
      assert.equal(parsed.toString(), callback);
    }
  }),
);

it.effect("rejects different targets, credentials, fragments, and duplicate OAuth fields", () =>
  Effect.gen(function* () {
    const callbacks = [
      "https://localhost:51234/auth/callback?state=owned-state&code=x",
      "http://127.0.0.1:51234/auth/callback?state=owned-state&code=x",
      "http://localhost:51235/auth/callback?state=owned-state&code=x",
      "http://localhost:51234/?state=owned-state&code=x",
      "http://localhost:51234/other?state=owned-state&code=x",
      "http://user:password@localhost:51234/auth/callback?state=owned-state&code=x",
      "http://localhost:51234/auth/callback?state=owned-state&code=x#fragment",
      "http://localhost:51234/auth/callback?state=wrong-state&code=x",
      "http://localhost:51234/auth/callback?state=owned-state&state=owned-state&code=x",
      "http://localhost:51234/auth/callback?state=owned-state&code=x&code=y",
      "http://localhost:51234/auth/callback?state=owned-state&code=x&error=access_denied",
      "http://localhost:51234/auth/callback?state=owned-state&error=access_denied&error=other",
      "http://localhost:51234/auth/callback?state=owned-state&code=",
      "http://localhost:51234/auth/callback?state=owned-state&iss=https%3A%2F%2Faccounts.google.com",
      "http://localhost:51234/auth/callback?state=owned-state&code=x&iss=https%3A%2F%2Fexample.com",
    ];
    for (const callback of callbacks) {
      const result = yield* validateAntigravityCallbackUrl(instanceId, pending, callback).pipe(
        Effect.exit,
      );
      assert.isTrue(Exit.isFailure(result), callback);
    }
  }),
);
