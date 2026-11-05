// @effect-diagnostics nodeBuiltinImport:off -- fixtures write native session databases.
import * as NodeSqlite from "node:sqlite";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { ANTIGRAVITY_CONVERSATION_SEGMENTS } from "./AntigravityChildWork.ts";

export const ROOT = "c1bf9826-e853-43f8-80c9-567bf51613df";
export const CHILD = "785b9661-4ba7-4e80-a196-f5f3fa8d269c";
export const CALL_ID = "call_8842615248706744499";
export const LAUNCH = {
  role: "Math Calculator",
  prompt: "Please calculate 2+2 and report the result back.",
  model: "flash_lite",
};
const INVOKE_TYPE_URL = "type.googleapis.com/exa.cortex.core.tools.InvokeSubagent";

// Mirrors agy 1.5.x: Step{1: type, 5: metadata{4: call{1 id, 2 name, 3 args}}, 15/20/24/19/114/140:
// per-type payload}; tool steps are type 132 with 140{2: result{1: output, 6: Any}}.
const varint = (value: number): number[] => {
  const bytes: number[] = [];
  while (value >= 0x80) {
    bytes.push((value & 0x7f) | 0x80);
    value = Math.floor(value / 0x80);
  }
  return [...bytes, value];
};
const field = (number: number, value: string | Uint8Array) => {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return [...varint(number * 8 + 2), ...varint(bytes.length), ...bytes];
};
const proto = (...parts: number[][]) => Uint8Array.from(parts.flat());

export interface StepRow {
  readonly type: number;
  readonly status?: number;
  readonly payload: Uint8Array;
  readonly metadata: Uint8Array;
}

const step = (type: number, metadata: Uint8Array, ...fields: number[][]): StepRow => ({
  type,
  payload: proto([...varint(1 * 8), ...varint(type)], field(5, metadata), ...fields),
  metadata,
});

const callMetadata = (callId: string, name: string, args: string) =>
  proto(field(4, proto(field(1, callId), field(2, name), field(3, args))));

const userInputStep = (textValue: string) =>
  step(14, proto(), field(19, proto(field(2, textValue))));

export const plannerStep = (input: {
  readonly text?: string;
  readonly calls?: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly args: string;
  }>;
}) =>
  step(
    15,
    proto(),
    field(
      20,
      proto(
        ...(input.text === undefined ? [] : [field(8, input.text)]),
        ...(input.calls ?? []).map((call) =>
          field(7, proto(field(1, call.id), field(2, call.name), field(3, call.args))),
        ),
      ),
    ),
  );

export const toolStep = (input: {
  readonly callId: string;
  readonly name: string;
  readonly args?: string;
  readonly output?: string;
  readonly result?: Uint8Array;
}) =>
  step(
    132,
    callMetadata(input.callId, input.name, input.args ?? "{}"),
    field(
      140,
      proto(
        field(1, proto(field(1, "Path"), field(2, '"/project/README.md"'))),
        field(
          2,
          proto(
            ...(input.output === undefined ? [] : [field(1, input.output)]),
            ...(input.result === undefined ? [] : [field(6, input.result)]),
          ),
        ),
      ),
    ),
  );

export const invokeStep = (input: {
  readonly callId: string;
  readonly launches: ReadonlyArray<typeof LAUNCH>;
  readonly children: ReadonlyArray<string>;
}) =>
  toolStep({
    callId: input.callId,
    name: "invoke_subagent",
    args: JSON.stringify({ ...input.launches[0], Role: input.launches[0]?.role }),
    output: "Created the following subagent",
    result: proto(
      field(1, INVOKE_TYPE_URL),
      field(
        2,
        proto(
          ...input.launches.map((launch) =>
            field(
              1,
              proto(
                field(1, "self"),
                field(2, launch.role),
                field(3, launch.prompt),
                field(12, launch.model),
              ),
            ),
          ),
          ...input.children.map((id) =>
            field(2, proto(field(1, id), field(2, `file:///brain/${id}/transcript.jsonl`))),
          ),
        ),
      ),
    ),
  });

const messageStep = (body: string) =>
  step(
    101,
    proto(),
    field(
      114,
      proto(
        field(1, "[Message] sender=x"),
        field(2, proto(field(1, "Message from agent"), field(10, proto(field(1, body))))),
      ),
    ),
  );

/** The parent's inbound step when a child reports back: 114{1: rendered, 4: {3 sender, 4 content}}. */
export const wakeMessageStep = (sender: string, content: string) =>
  step(
    101,
    proto(),
    field(
      114,
      proto(
        field(1, `[Message] timestamp=2026-11-05T18:45:22Z sender=${sender} content=${content}`),
        field(4, proto(field(3, sender), field(4, content))),
      ),
    ),
  );

export const errorStep = (input: {
  readonly title: string;
  readonly detail: string;
  readonly full: string;
}) =>
  step(
    17,
    proto(),
    field(
      24,
      proto(
        field(
          3,
          proto(
            field(1, input.title),
            field(2, input.detail),
            field(3, input.full),
            field(9, input.detail),
          ),
        ),
      ),
    ),
  );

export const childSteps = [
  messageStep(LAUNCH.prompt),
  plannerStep({
    calls: [{ id: "call_1", name: "read_file", args: '{"Path":"/project/README.md"}' }],
  }),
  toolStep({ callId: "call_1", name: "read_file", output: "2: child read marker 4242" }),
  plannerStep({ text: "marker 4242 found" }),
];

const metadataBlob = (parent: string | undefined) =>
  proto(
    field(1, "file:///ws"),
    ...(parent === undefined ? [] : [field(5, parent), field(6, parent)]),
    field(18, "default-cli-project"),
  );

export const writeConversation = (
  file: string,
  steps: ReadonlyArray<StepRow>,
  options: { readonly parent?: string; readonly first?: number } = {},
) => {
  const database = new NodeSqlite.DatabaseSync(file);
  database.exec(
    "CREATE TABLE steps (idx integer PRIMARY KEY, step_type integer NOT NULL DEFAULT 0, status integer NOT NULL DEFAULT 0, metadata blob, step_payload blob, step_format integer NOT NULL DEFAULT 0)",
  );
  database.exec(
    "CREATE TABLE trajectory_metadata_blob (id text DEFAULT 'main' PRIMARY KEY, data blob)",
  );
  const insert = database.prepare(
    "INSERT INTO steps (idx, step_type, status, metadata, step_payload) VALUES (?, ?, ?, ?, ?)",
  );
  steps.forEach((row, index) =>
    insert.run((options.first ?? 0) + index, row.type, row.status ?? 3, row.metadata, row.payload),
  );
  database
    .prepare("INSERT INTO trajectory_metadata_blob (id, data) VALUES ('main', ?)")
    .run(metadataBlob(options.parent));
  database.close();
};

export const makeProfile = Effect.fn("makeProfile")(function* (input: {
  /** Defaults to a scoped temp directory. */
  readonly profile?: string;
  readonly steps: ReadonlyArray<StepRow>;
  /** Written as the child's database; undefined writes none. */
  readonly child?: {
    readonly id?: string;
    readonly parent?: string;
    readonly steps: ReadonlyArray<StepRow>;
  };
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const profile = input.profile ?? (yield* fs.makeTempDirectoryScoped({ prefix: "t3-agy-child-" }));
  const conversations = path.join(profile, ...ANTIGRAVITY_CONVERSATION_SEGMENTS);
  yield* fs.makeDirectory(conversations, { recursive: true });
  writeConversation(path.join(conversations, `${ROOT}.db`), input.steps);
  if (input.child !== undefined) {
    writeConversation(
      path.join(conversations, `${input.child.id ?? CHILD}.db`),
      input.child.steps,
      { parent: input.child.parent ?? ROOT },
    );
  }
  return { profile, conversations };
});

export const launched = [
  userInputStep("Use a subagent."),
  plannerStep({ calls: [{ id: CALL_ID, name: "invoke_subagent", args: "{}" }] }),
  invokeStep({ callId: CALL_ID, launches: [LAUNCH], children: [CHILD] }),
];
