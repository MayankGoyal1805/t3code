import type { AntigravityAuthMethod } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as AcpErrors from "effect-acp/errors";

import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";

export const ANTIGRAVITY_SIGN_IN_REQUIRED_MESSAGE =
  "Sign in to Antigravity in Settings before you continue.";

const maxAuthorizationUrlLength = 16_384;
const decodeUrl = Schema.decodeUnknownEffect(Schema.URLFromString);
const isAcpRequestError = Schema.is(AcpErrors.AcpRequestError);
const isAcpTransportError = Schema.is(AcpErrors.AcpTransportError);

export interface AntigravityAuthConfig {
  readonly authMethod: AntigravityAuthMethod;
  readonly apiKey: string;
  readonly gcpProject: string;
  readonly gcpLocation: string;
}

export function antigravityAuthUsesBrowser(authMethod: AntigravityAuthMethod): boolean {
  return authMethod === "oauth-personal" || authMethod === "oauth-business";
}

export function antigravityAuthLabel(authMethod: AntigravityAuthMethod): string {
  switch (authMethod) {
    case "oauth-personal":
      return "Google account";
    case "oauth-business":
      return "Gemini Enterprise";
    case "gemini-api-key":
      return "Gemini API key";
    case "agent-platform":
      return "Agent Platform";
  }
}

export function antigravityAuthConfigIssue(auth: AntigravityAuthConfig): string | null {
  switch (auth.authMethod) {
    case "oauth-personal":
      return null;
    case "oauth-business":
      return auth.gcpProject && auth.gcpLocation
        ? null
        : "Gemini Enterprise needs a GCP project and location in the Antigravity provider settings.";
    case "gemini-api-key":
      return auth.apiKey ? null : "Enter a Gemini API key in the Antigravity provider settings.";
    case "agent-platform":
      return auth.apiKey || (auth.gcpProject && auth.gcpLocation)
        ? null
        : "Agent Platform needs an API key, or a GCP project and location, in the Antigravity provider settings.";
  }
}

export interface AntigravityAuthorizationUrl {
  readonly authorizationUrl: string;
  readonly redirectUri: string;
  readonly state: string;
}

function authSupportError(detail: string) {
  return new AcpErrors.AcpTransportError({ detail, cause: undefined });
}

export function isAntigravitySignInRequiredError(error: unknown): boolean {
  return (
    (isAcpRequestError(error) && error.code === -32000) ||
    (isAcpTransportError(error) && error.detail === ANTIGRAVITY_SIGN_IN_REQUIRED_MESSAGE)
  );
}

/**
 * Only the settings the user chose reach agy; every other variable, including
 * GOOGLE_APPLICATION_CREDENTIALS, passes through from the instance environment.
 */
function antigravityEnvironment(baseEnv: NodeJS.ProcessEnv, auth: AntigravityAuthConfig) {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    // Commands the agent runs inherit this; an Electron app they start would run as Node and exit.
    if (key.toUpperCase() !== "ELECTRON_RUN_AS_NODE") environment[key] = value;
  }
  const project = auth.gcpProject
    ? {
        GOOGLE_CLOUD_PROJECT: auth.gcpProject,
        ...(auth.gcpLocation
          ? { GOOGLE_CLOUD_LOCATION: auth.gcpLocation, GOOGLE_CLOUD_REGION: auth.gcpLocation }
          : {}),
      }
    : {};
  switch (auth.authMethod) {
    case "gemini-api-key":
      return { ...environment, GEMINI_API_KEY: auth.apiKey };
    case "agent-platform":
      return {
        ...environment,
        GOOGLE_GENAI_USE_VERTEXAI: "true",
        ...(auth.apiKey ? { GOOGLE_API_KEY: auth.apiKey } : {}),
        ...project,
      };
    case "oauth-business":
      return { ...environment, ...project };
    case "oauth-personal":
      return environment;
  }
}

/** Instances with their own home use `--gemini-dir`; the default instance leaves agy on `~/.gemini`. */
export function buildAntigravityAcpSpawnInput(input: {
  readonly executablePath: string;
  readonly geminiDirectoryArgs: ReadonlyArray<string>;
  readonly cwd: string;
  readonly baseEnv: NodeJS.ProcessEnv;
  readonly auth: AntigravityAuthConfig;
  /** Sign-in only: a directory whose `xdg-open` and `open` hand the URL to T3 Code. */
  readonly browserCaptureDirectory?: string;
  readonly platform: NodeJS.Platform;
}): AcpSessionRuntime.AcpSpawnInput {
  const environment = antigravityEnvironment(input.baseEnv, input.auth);
  const capture = input.browserCaptureDirectory;
  const pathKey = Object.keys(environment).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  return {
    command: input.executablePath,
    args: ["acp", ...input.geminiDirectoryArgs],
    cwd: input.cwd,
    env:
      capture === undefined
        ? environment
        : {
            ...environment,
            [pathKey]:
              capture + (input.platform === "win32" ? ";" : ":") + (environment[pathKey] ?? ""),
            // agy opens a browser only when a display exists; the capture scripts never connect to it.
            ...(input.platform === "linux" && !environment.DISPLAY && !environment.WAYLAND_DISPLAY
              ? { DISPLAY: ":0" }
              : {}),
          },
    extendEnv: false,
  };
}

const ANTIGRAVITY_BROWSER_CAPTURE_FILE = "authorization-url";

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/**
 * agy sends no browser URL over ACP; it runs `xdg-open <url>` (`open` on macOS) and discards the
 * helper's output, so the helper leaves the URL in a file for T3 Code to read.
 */
export const writeAntigravityBrowserCapture = Effect.fn("writeAntigravityBrowserCapture")(
  function* (directory: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const target = path.join(directory, ANTIGRAVITY_BROWSER_CAPTURE_FILE);
    const script =
      `#!/bin/sh\n` +
      `printf '%s\\n' "$1" > ${quoteShell(`${target}.part`)} && mv ${quoteShell(`${target}.part`)} ${quoteShell(target)}\n`;
    for (const name of ["xdg-open", "open"]) {
      yield* fs.writeFileString(path.join(directory, name), script, { mode: 0o755 });
    }
    return target;
  },
);

export const readAntigravityBrowserCapture = Effect.fn("readAntigravityBrowserCapture")(function* (
  target: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(target).pipe(Effect.orElseSucceed(() => ""));
  return text.trim() || undefined;
});

/** agy launches its browser again when a sign-in is retried, so each new URL is handed over until the flow's scope closes. */
export const watchAntigravityAuthorizationUrl = Effect.fn("watchAntigravityAuthorizationUrl")(
  function* (
    target: string,
    onAuthorizationUrl: (url: string) => Effect.Effect<void, AcpErrors.AcpError>,
  ) {
    let delivered: string | undefined;
    for (;;) {
      const url = yield* readAntigravityBrowserCapture(target);
      if (url !== undefined && url !== delivered) {
        delivered = url;
        yield* onAuthorizationUrl(url).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Antigravity sign-in URL was rejected.", { cause }),
          ),
        );
      }
      yield* Effect.sleep("250 millis");
    }
  },
);

export const parseAntigravityAuthorizationUrl = Effect.fn("parseAntigravityAuthorizationUrl")(
  function* (
    authorizationUrl: string,
  ): Effect.fn.Return<AntigravityAuthorizationUrl, AcpErrors.AcpError> {
    const invalidUrl = () =>
      authSupportError("Antigravity returned an invalid Google sign-in URL.");
    if (authorizationUrl.length > maxAuthorizationUrlLength || /\s/.test(authorizationUrl)) {
      return yield* invalidUrl();
    }
    const url = yield* decodeUrl(authorizationUrl).pipe(Effect.mapError(invalidUrl));
    const state = url.searchParams.get("state");
    const redirectUri = url.searchParams.get("redirect_uri");
    if (
      url.origin !== "https://accounts.google.com" ||
      !/^\/o\/oauth2\/(?:v2\/)?auth$/.test(url.pathname) ||
      url.username !== "" ||
      url.password !== "" ||
      url.hash !== "" ||
      url.searchParams.getAll("state").length !== 1 ||
      url.searchParams.getAll("redirect_uri").length !== 1 ||
      url.searchParams.getAll("response_type").length !== 1 ||
      url.searchParams.get("response_type") !== "code" ||
      state === null ||
      state.length === 0 ||
      state.length > 512 ||
      /\s/.test(state) ||
      redirectUri === null ||
      !/^http:\/\/localhost:[1-9][0-9]{0,4}\/auth\/callback$/.test(redirectUri)
    ) {
      return yield* invalidUrl();
    }
    const redirect = yield* decodeUrl(redirectUri).pipe(Effect.mapError(invalidUrl));
    if (Number(redirect.port) < 1_024) return yield* invalidUrl();
    return { authorizationUrl, redirectUri, state };
  },
);
