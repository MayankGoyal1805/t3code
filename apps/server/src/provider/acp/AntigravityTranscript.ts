import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** One line of agy's `transcript_full.jsonl`; fields T3 Code does not read are dropped. */
const TranscriptStep = Schema.Struct({
  step_index: Schema.Int,
  type: Schema.String,
  status: Schema.optional(Schema.String),
  content: Schema.optional(Schema.String),
  tool_calls: Schema.optional(
    Schema.Array(
      Schema.Struct({
        name: Schema.String,
        args: Schema.optional(Schema.Unknown),
        id: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
});

export type AntigravityTranscriptStep = typeof TranscriptStep.Type;

const LINE_INDEX = /^\{"step_index":(\d+)/;
const decodeStep = Schema.decodeUnknownOption(Schema.fromJsonString(TranscriptStep));

/** Steps whose index is at least `from`, in order. A partial first or last line is skipped. */
export function parseAntigravityTranscript(
  text: string,
  from: number,
  options?: { readonly truncatedStart?: boolean },
): ReadonlyArray<AntigravityTranscriptStep> {
  // A line still being written is not valid JSON yet and decodes to nothing.
  const lines = text.split("\n");
  if (options?.truncatedStart === true) lines.shift();
  return lines.flatMap((line) => {
    // Each line opens with its index, so older steps are skipped without decoding them.
    const index = LINE_INDEX.exec(line);
    if (index !== null && Number(index[1]) < from) return [];
    const step = decodeStep(line);
    return Option.isSome(step) && step.value.step_index >= from ? [step.value] : [];
  });
}

const MAX_READ_BYTES = 4 * 1024 * 1024;

/** Reads the end of a transcript, which is where a wake's steps are. A missing file reads as no steps. */
export const readAntigravityTranscript = Effect.fn("readAntigravityTranscript")(function* (
  transcriptPath: string,
  from: number,
) {
  const fs = yield* FileSystem.FileSystem;
  return yield* Effect.gen(function* () {
    const size = Number((yield* fs.stat(transcriptPath)).size);
    const start = Math.max(0, size - MAX_READ_BYTES);
    const chunk = yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* fs.open(transcriptPath, { flag: "r" });
        return yield* handle.readAlloc(size - start, { position: BigInt(start) });
      }),
    );
    if (Option.isNone(chunk)) return [] as ReadonlyArray<AntigravityTranscriptStep>;
    return parseAntigravityTranscript(new TextDecoder().decode(chunk.value), from, {
      truncatedStart: start > 0,
    });
  }).pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<AntigravityTranscriptStep>));
});
