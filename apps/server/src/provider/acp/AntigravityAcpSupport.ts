import {
  ANTIGRAVITY_DEFAULT_MODEL,
  type AntigravityAuthMethod,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ProviderSendTurnInput,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/compat";

import { antigravityAuthUsesBrowser } from "../antigravityAuthSupport.ts";
import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import { normalizeAntigravitySessionUpdate } from "./AntigravityProtocol.ts";

export interface AntigravityAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  | "authMethodId"
  | "authenticateEagerly"
  | "cancelBehavior"
  | "clientCapabilities"
  | "clientInfo"
  | "onStderr"
  | "resumeMethod"
  | "sessionMeta"
  | "transformSessionUpdate"
  | "transformStdout"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  /** Set only while signing in: agy then runs its browser flow instead of reporting sign-in required. */
  readonly onAuthorizationUrl?: (url: string) => Effect.Effect<void, EffectAcpErrors.AcpError>;
  /** Conversational sessions only; helpers and probes leave the system prompt untouched. */
  readonly sessionSystemPromptAppend?: string;
  readonly authMethod?: AntigravityAuthMethod;
}

/** agy advertises `_meta.antigravity.systemPrompt.append` on `initialize`; it is sent again on every activation. */
export const antigravityAppendsSystemPrompt = (
  initializeResult: EffectAcpSchema.InitializeResponse,
) => {
  const antigravity = initializeResult.agentCapabilities?._meta?.antigravity;
  return (
    typeof antigravity === "object" &&
    antigravity !== null &&
    "systemPrompt" in antigravity &&
    typeof antigravity.systemPrompt === "object" &&
    antigravity.systemPrompt !== null &&
    "append" in antigravity.systemPrompt &&
    antigravity.systemPrompt.append === true
  );
};

export function antigravitySessionMeta(
  initializeResult: EffectAcpSchema.InitializeResponse,
  systemPromptAppend?: string,
): EffectAcpSchema.NewSessionRequest["_meta"] | undefined {
  return systemPromptAppend !== undefined && antigravityAppendsSystemPrompt(initializeResult)
    ? { antigravity: { systemPrompt: { append: systemPromptAppend } } }
    : undefined;
}

export const makeAntigravityAcpRuntime = Effect.fn("makeAntigravityAcpRuntime")(function* (
  input: AntigravityAcpRuntimeInput,
): Effect.fn.Return<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  SecureRandom.SecureRandom | Scope.Scope
> {
  const authMethod = input.authMethod ?? "oauth-personal";
  // A browser sign-in must never start unattended: without a sign-in flow, "Authentication required" surfaces.
  const signingIn = input.onAuthorizationUrl !== undefined;
  const interactiveAuth = antigravityAuthUsesBrowser(authMethod);
  const context = yield* Layer.build(
    AcpSessionRuntime.layer({
      ...input,
      authMethodId: authMethod,
      authenticateEagerly: !interactiveAuth || signingIn,
      authenticateOnAuthRequired: !interactiveAuth || signingIn,
      resumeMethod: "resume",
      cancelBehavior: "wait-for-prompt",
      // The agent offers non-Gemini models only to allowlisted clients such as Zed.
      clientInfo: { name: "zed", version: "0.0.0" },
      sessionMeta: (initializeResult) =>
        antigravitySessionMeta(initializeResult, input.sessionSystemPromptAppend),
      // agy reads and edits files itself and ignores client file and terminal capabilities.
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      transformSessionUpdate: normalizeAntigravitySessionUpdate,
    }).pipe(
      Layer.provide(
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
      ),
    ),
  );
  return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(Effect.provide(context));
});

export function antigravityPermissionMode(runtimeMode: RuntimeMode): string {
  switch (runtimeMode) {
    // agy has no mode that approves commands too; T3 Code answers its permission requests.
    case "full-access":
    case "auto-accept-edits":
      return "accept-edits";
    case "auto":
    case "approval-required":
      return "default";
  }
}

/** The runtime mode an Antigravity session mode grants; the inverse of `antigravityPermissionMode`. */
export function antigravityRuntimeModeForSessionMode(modeId: string): RuntimeMode | undefined {
  switch (modeId) {
    case "accept-edits":
      return "auto-accept-edits";
    case "default":
      return "approval-required";
    default:
      return undefined;
  }
}

function antigravityModelOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
) {
  const model = configOptions.find((option) => option.id === "model");
  if (model?.type !== "select") return [];
  return model.options.flatMap((entry) => ("value" in entry ? [entry] : entry.options));
}

/** agy reports the selected model's thinking levels as the `thought_level` option. */
export function antigravityThinkingConfig(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
) {
  const option = configOptions?.find((candidate) => candidate.category === "thought_level");
  return option?.type === "select" ? option : undefined;
}

/**
 * Models to select so agy reports their thinking levels, which it gives only for the selected one.
 * The selected model goes last to restore the session; nothing is selected when all are known.
 */
export function antigravityModelsToProbeForThinking(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
  hasThinkingLevels: (model: string) => boolean,
): ReadonlyArray<string> {
  const current = configOptions.find((option) => option.id === "model")?.currentValue;
  if (antigravityThinkingConfig(configOptions) === undefined || typeof current !== "string") {
    return [];
  }
  const unknown = antigravityModelOptions(configOptions)
    .map((option) => option.value)
    .filter((model) => model !== current && !hasThinkingLevels(model));
  return unknown.length === 0 ? [] : [...unknown, current];
}

const BUNDLE_FLASH_MODEL = /^gemini-3\.[678]-flash-(low|medium|high)$/;

/** The bundle runtime listed each thinking level as its own model; agy has one model plus `thought_level`. */
function migrateAntigravityBundleModel(model: string | null | undefined) {
  const level = model == null ? undefined : BUNDLE_FLASH_MODEL.exec(model)?.[1];
  return level === undefined
    ? { model, thoughtLevel: undefined }
    : { model: "gemini-3.8-flash", thoughtLevel: level };
}

function resolveAntigravityModel(input: {
  readonly configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>;
  readonly model: string | null | undefined;
  readonly defaultModel?: string | undefined;
}): string | undefined {
  const modelConfig = input.configOptions.find((option) => option.id === "model");
  const current = modelConfig?.type === "select" ? modelConfig.currentValue : undefined;
  if (input.model && input.model !== ANTIGRAVITY_DEFAULT_MODEL) return input.model;
  const options = antigravityModelOptions(input.configOptions);
  return input.defaultModel && options.some((option) => option.value === input.defaultModel)
    ? input.defaultModel
    : current;
}

/** Never replace a saved selection with the default returned by a cold resume. */
export const applyAntigravityAcpModelSelection = Effect.fn("applyAntigravityAcpModelSelection")(
  function* <E>(input: {
    readonly runtime: Pick<
      AcpSessionRuntime.AcpSessionRuntime["Service"],
      "getConfigOptions" | "setModel" | "setConfigOption"
    >;
    readonly model: string | null | undefined;
    readonly defaultModel?: string | undefined;
    readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
  }): Effect.fn.Return<string | undefined, E> {
    const { model: requestedModel, thoughtLevel } = migrateAntigravityBundleModel(input.model);
    const configOptions = yield* input.runtime.getConfigOptions;
    const modelConfig = configOptions.find((option) => option.id === "model");
    const current = modelConfig?.type === "select" ? modelConfig.currentValue : undefined;
    const resolved = resolveAntigravityModel({
      configOptions,
      model: requestedModel,
      defaultModel: input.defaultModel,
    });
    const explicit = Boolean(requestedModel) && requestedModel !== ANTIGRAVITY_DEFAULT_MODEL;
    if (resolved === undefined || (!explicit && resolved === current)) return current;
    const options = antigravityModelOptions(configOptions);
    if (!options.some((option) => option.value === resolved)) {
      return yield* Effect.fail(
        input.mapError(
          EffectAcpErrors.AcpRequestError.invalidParams(
            `Antigravity model '${resolved}' is unavailable for this Google account. Select an available model.`,
          ),
        ),
      );
    }
    yield* input.runtime.setModel(resolved).pipe(Effect.mapError(input.mapError));
    if (thoughtLevel !== undefined) {
      // Option values are per model, so read them after the switch.
      const thinking = antigravityThinkingConfig(yield* input.runtime.getConfigOptions);
      if (
        thinking !== undefined &&
        thinking.currentValue !== thoughtLevel &&
        thinking.options.some((entry) => "value" in entry && entry.value === thoughtLevel)
      ) {
        yield* input.runtime
          .setConfigOption(thinking.id, thoughtLevel)
          .pipe(Effect.mapError(input.mapError));
      }
    }
    return resolved;
  },
);

const IMAGE_MIME_TYPES = new Set(["image/bmp", "image/jpeg", "image/png", "image/webp"]);
const AUDIO_MIME_TYPES = new Set([
  "audio/aac",
  "audio/flac",
  "audio/mp3",
  "audio/mpeg",
  "audio/mp4",
  "audio/m4a",
  "audio/x-m4a",
  "audio/ogg",
  "audio/wav",
  "audio/x-wav",
  "audio/webm",
]);
const ANTIGRAVITY_MAX_AUDIO_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const TEXT_MIME_TYPES = new Set([
  "application/json",
  "application/ld+json",
  "application/javascript",
  "application/typescript",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
  "application/x-sh",
]);
const TEXT_FILE_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".mdx",
  ".json",
  ".jsonl",
  ".yaml",
  ".yml",
  ".toml",
  ".xml",
  ".csv",
  ".tsv",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".html",
  ".css",
  ".scss",
  ".less",
  ".py",
  ".rs",
  ".go",
  ".java",
  ".kt",
  ".swift",
  ".c",
  ".h",
  ".cc",
  ".cpp",
  ".hpp",
  ".cs",
  ".rb",
  ".php",
  ".sh",
  ".bash",
  ".zsh",
  ".sql",
  ".graphql",
  ".svelte",
  ".vue",
  ".log",
  ".diff",
  ".patch",
  ".ini",
  ".conf",
]);
const ANTIGRAVITY_MAX_TEXT_ATTACHMENT_BYTES = 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = PROVIDER_SEND_TURN_MAX_FILE_BYTES;

export const buildAntigravityPrompt = Effect.fn("buildAntigravityPrompt")(function* (input: {
  readonly input: ProviderSendTurnInput["input"];
  readonly attachments: ProviderSendTurnInput["attachments"];
  readonly resolveAttachmentPath: (
    attachment: NonNullable<ProviderSendTurnInput["attachments"]>[number],
  ) => string | null;
  readonly promptCapabilities: EffectAcpSchema.AgentCapabilities["promptCapabilities"];
}): Effect.fn.Return<
  ReadonlyArray<EffectAcpSchema.ContentBlock>,
  EffectAcpErrors.AcpError,
  FileSystem.FileSystem | Path.Path
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const blocks: Array<EffectAcpSchema.ContentBlock> = [];
  const text = input.input?.trim();
  if (text) blocks.push({ type: "text", text });
  let totalBytes = 0;

  for (const attachment of input.attachments ?? []) {
    const isPastedText =
      attachment.type === "file" &&
      "source" in attachment &&
      attachment.source?._tag === "pasted-text";
    // The text already carries the path; keep folded pastes lazy so agents can search without embedding the whole file.
    const mimeType = attachment.mimeType.toLowerCase().split(";", 1)[0] ?? "";
    const image = attachment.type === "image" && IMAGE_MIME_TYPES.has(mimeType);
    const audio = attachment.type === "file" && AUDIO_MIME_TYPES.has(mimeType);
    const pdf = attachment.type === "file" && mimeType === "application/pdf";
    const textFile =
      attachment.type === "file" &&
      (mimeType.startsWith("text/") ||
        TEXT_MIME_TYPES.has(mimeType) ||
        TEXT_FILE_EXTENSIONS.has(path.extname(attachment.name).toLowerCase()));
    const isPathOnly =
      (attachment.type === "image" && (!image || input.promptCapabilities?.image !== true)) ||
      (attachment.type === "file" &&
        (isPastedText ||
          (audio
            ? input.promptCapabilities?.audio !== true
            : pdf || textFile
              ? input.promptCapabilities?.embeddedContext !== true
              : true)));
    const attachmentPath = input.resolveAttachmentPath(attachment);
    if (!attachmentPath) {
      return yield* EffectAcpErrors.AcpRequestError.invalidParams(
        `Invalid attachment '${attachment.name}'.`,
      );
    }
    const info = yield* fileSystem
      .stat(attachmentPath)
      .pipe(
        Effect.mapError(() =>
          EffectAcpErrors.AcpRequestError.invalidParams(
            `Could not read attachment '${attachment.name}'.`,
          ),
        ),
      );
    if (info.type !== "File") {
      return yield* EffectAcpErrors.AcpRequestError.invalidParams(
        `Could not read attachment '${attachment.name}'.`,
      );
    }
    if (isPathOnly) continue;
    const size = Number(info.size);
    const limit = image
      ? PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
      : audio
        ? ANTIGRAVITY_MAX_AUDIO_ATTACHMENT_BYTES
        : pdf
          ? MAX_TOTAL_ATTACHMENT_BYTES
          : ANTIGRAVITY_MAX_TEXT_ATTACHMENT_BYTES;
    if (
      attachment.type === "file" &&
      (size > limit || totalBytes + size > MAX_TOTAL_ATTACHMENT_BYTES)
    ) {
      continue;
    }
    totalBytes += size;
    if (size > limit || totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
      return yield* EffectAcpErrors.AcpRequestError.invalidParams(
        `Image '${attachment.name}' is too large. Antigravity accepts images up to 10 MiB and 50 MiB of native attachments per message.`,
      );
    }
    const uri = yield* path.toFileUrl(attachmentPath).pipe(
      Effect.map((url) => url.href),
      Effect.mapError(() =>
        EffectAcpErrors.AcpRequestError.invalidParams(`Invalid attachment '${attachment.name}'.`),
      ),
    );
    if (pdf) {
      blocks.push({ type: "resource_link", uri, name: attachment.name, mimeType, size });
      continue;
    }
    const bytes = yield* fileSystem.stream(attachmentPath, { bytesToRead: limit + 1 }).pipe(
      Stream.runCollect,
      Effect.map((chunks) => Buffer.concat(chunks)),
      Effect.mapError(() =>
        EffectAcpErrors.AcpRequestError.invalidParams(
          `Could not read attachment '${attachment.name}'.`,
        ),
      ),
    );
    totalBytes += bytes.length - size;
    if (bytes.length > limit || totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
      return yield* EffectAcpErrors.AcpRequestError.invalidParams(
        `Attachment '${attachment.name}' changed while being read and is too large.`,
      );
    }
    if (image) {
      blocks.push({ type: "image", data: Buffer.from(bytes).toString("base64"), mimeType });
    } else if (audio) {
      blocks.push({ type: "audio", data: Buffer.from(bytes).toString("base64"), mimeType });
    } else {
      const decoded = yield* Effect.try({
        try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        catch: () =>
          EffectAcpErrors.AcpRequestError.invalidParams(
            `Attachment '${attachment.name}' is not a UTF-8 text file.`,
          ),
      });
      if (decoded.includes("\0")) {
        return yield* EffectAcpErrors.AcpRequestError.invalidParams(
          `Attachment '${attachment.name}' contains binary data.`,
        );
      }
      blocks.push({ type: "resource", resource: { uri, mimeType, text: decoded } });
    }
  }
  if (blocks.length === 0) {
    return yield* EffectAcpErrors.AcpRequestError.invalidParams(
      "A turn requires text or supported attachments.",
    );
  }
  return blocks;
});
