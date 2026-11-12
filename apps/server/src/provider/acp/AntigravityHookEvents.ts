import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

const HookPayload = Schema.Struct({
  conversationId: Schema.String,
  transcriptPath: Schema.optional(Schema.String),
  stepIdx: Schema.optional(Schema.Int),
  invocationNum: Schema.optional(Schema.Int),
  initialNumSteps: Schema.optional(Schema.Int),
  toolCall: Schema.optional(
    Schema.Struct({ name: Schema.String, args: Schema.optional(Schema.Unknown) }),
  ),
  error: Schema.optional(Schema.NullOr(Schema.String)),
  fullyIdle: Schema.optional(Schema.Boolean),
});

export type AntigravityHookName = "PreInvocation" | "PostToolUse" | "Stop";
const HOOK_NAMES: ReadonlySet<string> = new Set<AntigravityHookName>([
  "PreInvocation",
  "PostToolUse",
  "Stop",
]);

export type AntigravityHookEvent = typeof HookPayload.Type & { readonly name: AntigravityHookName };

const decodePayload = Schema.decodeUnknownOption(Schema.fromJsonString(HookPayload));

/** One line of the events file: `<EventName>\t<hook stdin json>`. Anything else is ignored. */
export function decodeAntigravityHookLine(line: string): AntigravityHookEvent | undefined {
  const separator = line.indexOf("\t");
  if (separator <= 0) return undefined;
  const name = line.slice(0, separator);
  if (!HOOK_NAMES.has(name)) return undefined;
  const payload = decodePayload(line.slice(separator + 1));
  return Option.isSome(payload)
    ? { ...payload.value, name: name as AntigravityHookName }
    : undefined;
}

/** Splits appended text into complete lines; a trailing partial line waits for its newline. */
export function takeCompleteLines(pending: string): {
  readonly lines: ReadonlyArray<string>;
  readonly rest: string;
} {
  const end = pending.lastIndexOf("\n");
  if (end < 0) return { lines: [], rest: pending };
  return {
    lines: pending
      .slice(0, end)
      .split("\n")
      .filter((line) => line.length > 0),
    rest: pending.slice(end + 1),
  };
}

const MAX_READ_BYTES = 4 * 1024 * 1024;
/** fs.watch can miss appends on some filesystems, so a slow tick backs it up. */
const SAFETY_TICK = "3 seconds";

/**
 * Decoded hook events appended to `file`. Woken by `fs.watch`, with a slow
 * tick as the fallback when watching is unavailable.
 */
export const tailAntigravityHookEvents = (
  file: string,
): Stream.Stream<AntigravityHookEvent, never, FileSystem.FileSystem> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      let offset = 0;
      let rest = "";
      const decoder = new TextDecoder();
      const readNew = Effect.fn("AntigravityHookEvents.readNew")(function* () {
        const size = Number((yield* fs.stat(file)).size);
        if (size < offset) {
          offset = 0;
          rest = "";
          decoder.decode();
        }
        if (size === offset) return [] as ReadonlyArray<AntigravityHookEvent>;
        const length = Math.min(size - offset, MAX_READ_BYTES);
        const chunk = yield* Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* fs.open(file, { flag: "r" });
            return yield* handle.readAlloc(length, { position: BigInt(offset) });
          }),
        );
        if (Option.isNone(chunk)) return [];
        offset += chunk.value.byteLength;
        const taken = takeCompleteLines(rest + decoder.decode(chunk.value, { stream: true }));
        rest = taken.rest;
        return taken.lines.flatMap((line) => {
          const event = decodeAntigravityHookLine(line);
          return event === undefined ? [] : [event];
        });
      });
      const wakeups = Stream.merge(
        fs.watch(file).pipe(Stream.catch(() => Stream.empty)),
        Stream.tick(SAFETY_TICK),
      );
      return wakeups.pipe(
        Stream.mapEffect(() => readNew().pipe(Effect.orElseSucceed(() => []))),
        Stream.flattenIterable,
      );
    }),
  );
