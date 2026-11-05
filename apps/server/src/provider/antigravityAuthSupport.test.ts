import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as AcpErrors from "effect-acp/errors";

import {
  ANTIGRAVITY_SIGN_IN_REQUIRED_MESSAGE,
  type AntigravityAuthConfig,
  buildAntigravityAcpSpawnInput,
  isAntigravitySignInRequiredError,
  parseAntigravityAuthorizationUrl,
  readAntigravityBrowserCapture,
  watchAntigravityAuthorizationUrl,
  writeAntigravityBrowserCapture,
} from "./antigravityAuthSupport.ts";

const authorizationUrl =
  "https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=test-client" +
  "&code_challenge=test-challenge&code_challenge_method=S256&prompt=consent" +
  "&redirect_uri=http%3A%2F%2Flocalhost%3A34299%2Fauth%2Fcallback&response_type=code" +
  "&scope=openid&state=test-opaque-state";
const encodeUnknownJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const personal: AntigravityAuthConfig = {
  authMethod: "oauth-personal",
  apiKey: "",
  gcpProject: "",
  gcpLocation: "",
};

const spawnInput = (overrides: Partial<Parameters<typeof buildAntigravityAcpSpawnInput>[0]> = {}) =>
  buildAntigravityAcpSpawnInput({
    executablePath: "agy",
    geminiDirectoryArgs: [],
    cwd: "/work",
    baseEnv: { PATH: "/usr/bin" },
    auth: personal,
    platform: "linux",
    ...overrides,
  });

describe("Antigravity spawn input", () => {
  it("runs `agy acp` and adds --gemini-dir only for an instance with its own home", () => {
    expect(spawnInput().args).toEqual(["acp"]);
    expect(spawnInput({ geminiDirectoryArgs: ["--gemini-dir", ".gemini-work"] }).args).toEqual([
      "acp",
      "--gemini-dir",
      ".gemini-work",
    ]);
  });

  it("passes the user's credentials through and drops only ELECTRON_RUN_AS_NODE", () => {
    const env = spawnInput({
      baseEnv: {
        PATH: "/usr/bin",
        GOOGLE_APPLICATION_CREDENTIALS: "/keys/adc.json",
        GEMINI_API_KEY: "from-shell",
        ELECTRON_RUN_AS_NODE: "1",
      },
    }).env;
    expect(env).toEqual({
      PATH: "/usr/bin",
      GOOGLE_APPLICATION_CREDENTIALS: "/keys/adc.json",
      GEMINI_API_KEY: "from-shell",
    });
  });

  it("maps the configured method's settings to the variables agy reads", () => {
    expect(
      spawnInput({ auth: { ...personal, authMethod: "gemini-api-key", apiKey: "key" } }).env,
    ).toMatchObject({ GEMINI_API_KEY: "key" });
    expect(
      spawnInput({
        auth: {
          authMethod: "agent-platform",
          apiKey: "",
          gcpProject: "project",
          gcpLocation: "us-central1",
        },
      }).env,
    ).toMatchObject({
      GOOGLE_GENAI_USE_VERTEXAI: "true",
      GOOGLE_CLOUD_PROJECT: "project",
      GOOGLE_CLOUD_LOCATION: "us-central1",
    });
  });

  it("puts the browser stand-in first on PATH and supplies a display only when none exists", () => {
    const captured = spawnInput({ browserCaptureDirectory: "/capture" }).env;
    expect(captured).toMatchObject({ PATH: "/capture:/usr/bin", DISPLAY: ":0" });
    expect(
      spawnInput({
        browserCaptureDirectory: "/capture",
        baseEnv: { PATH: "/usr/bin", WAYLAND_DISPLAY: "wayland-0" },
      }).env?.DISPLAY,
    ).toBeUndefined();
    expect(
      spawnInput({ browserCaptureDirectory: "/capture", platform: "darwin" }).env?.DISPLAY,
    ).toBeUndefined();
  });
});

describe("Antigravity authorization URL", () => {
  it.effect("accepts agy's loopback sign-in URL", () =>
    Effect.gen(function* () {
      const parsed = yield* parseAntigravityAuthorizationUrl(authorizationUrl);
      expect(parsed).toEqual({
        authorizationUrl,
        redirectUri: "http://localhost:34299/auth/callback",
        state: "test-opaque-state",
      });
    }),
  );

  it.effect(
    "rejects other origins, ambiguous state, and non-loopback redirects without retaining them",
    () =>
      Effect.gen(function* () {
        const invalidUrls = [
          authorizationUrl.replace("https:", "http:"),
          authorizationUrl.replace("accounts.google.com", "accounts.google.com.example.invalid"),
          authorizationUrl.replace("accounts.google.com", "secret@accounts.google.com"),
          authorizationUrl.replace("/o/oauth2/auth", "/another-path"),
          `${authorizationUrl}#secret-fragment`,
          `${authorizationUrl}&state=another-state`,
          authorizationUrl.replace("test-opaque-state", ""),
          authorizationUrl.replace("test-opaque-state", "opaque%0astate"),
          authorizationUrl.replace("localhost", "127.0.0.1"),
          authorizationUrl.replace("localhost", "169.254.169.254"),
          authorizationUrl.replace("34299", "80"),
          authorizationUrl.replace("34299", "70000"),
          authorizationUrl.replace("%2Fauth%2Fcallback", "%2Fother"),
          authorizationUrl.replace("response_type=code", "response_type=token"),
          "not a URL containing secret-code",
        ];
        for (const invalidUrl of invalidUrls) {
          const result = yield* parseAntigravityAuthorizationUrl(invalidUrl).pipe(Effect.result);
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isSuccess(result)) continue;
          expect(result.failure._tag).toBe("AcpTransportError");
          expect(encodeUnknownJson(result.failure)).not.toContain("test-opaque-state");
          expect(encodeUnknownJson(result.failure)).not.toContain("secret-code");
          expect(encodeUnknownJson(result.failure)).not.toContain(invalidUrl);
        }
      }),
  );
});

it.layer(NodeServices.layer)("Antigravity browser capture", (it) => {
  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "turns agy's `xdg-open <url>` call into the URL T3 Code reads",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agy-capture-test-" });
        const target = yield* writeAntigravityBrowserCapture(directory);
        expect(yield* readAntigravityBrowserCapture(target)).toBeUndefined();
        for (const helper of ["xdg-open", "open"]) {
          const exitCode = yield* spawner.exitCode(
            ChildProcess.make(path.join(directory, helper), [authorizationUrl]),
          );
          expect(Number(exitCode)).toBe(0);
          expect(yield* readAntigravityBrowserCapture(target)).toBe(authorizationUrl);
          yield* fs.remove(target);
        }
      }).pipe(Effect.scoped),
  );

  it.effect("hands the captured URL to the sign-in flow once", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agy-capture-test-" });
      const target = path.join(directory, "authorization-url");
      yield* fs.writeFileString(target, `${authorizationUrl}\n`);
      const received: Array<string> = [];
      yield* watchAntigravityAuthorizationUrl(target, (url) =>
        Effect.sync(() => {
          received.push(url);
        }),
      ).pipe(Effect.provideService(FileSystem.FileSystem, fs));
      expect(received).toEqual([authorizationUrl]);
    }).pipe(Effect.scoped),
  );
});

describe("Antigravity sign-in errors", () => {
  it("recognizes native auth-required errors and the blocked-login transport error", () => {
    expect(isAntigravitySignInRequiredError(AcpErrors.AcpRequestError.authRequired())).toBe(true);
    expect(
      isAntigravitySignInRequiredError(
        new AcpErrors.AcpTransportError({
          detail: ANTIGRAVITY_SIGN_IN_REQUIRED_MESSAGE,
          cause: undefined,
        }),
      ),
    ).toBe(true);
  });

  it("does not treat other failures or arbitrary text as missing authentication", () => {
    const otherErrors = [
      new AcpErrors.AcpTransportError({ detail: "The process stopped.", cause: undefined }),
      AcpErrors.AcpRequestError.internalError(ANTIGRAVITY_SIGN_IN_REQUIRED_MESSAGE),
      new Error(ANTIGRAVITY_SIGN_IN_REQUIRED_MESSAGE),
      { detail: ANTIGRAVITY_SIGN_IN_REQUIRED_MESSAGE },
      ANTIGRAVITY_SIGN_IN_REQUIRED_MESSAGE,
      undefined,
    ];
    for (const error of otherErrors) expect(isAntigravitySignInRequiredError(error)).toBe(false);
  });
});
