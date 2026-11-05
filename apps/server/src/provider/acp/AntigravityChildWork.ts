// @effect-diagnostics nodeBuiltinImport:off -- node:sqlite reads the native session database read-only.
import * as NodeSqlite from "node:sqlite";

import type {
  OrchestrationV2NativeChildStep,
  OrchestrationV2NativeChildWork,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { messages, message, text } from "./AntigravityProto.ts";
import { antigravityManagedPath, antigravityProfileRoot } from "./AntigravityProfilePaths.ts";

// Field numbers from the agy CLI's step protos (exa.cortex_pb), checked against 1.5.x databases.
const STEP_METADATA = 5;
const METADATA_TOOL_CALL = 4;
const STEP_USER_INPUT_FIELD = 19;
const STEP_PLANNER_RESPONSE = 20;
const PLANNER_TOOL_CALLS = 7;
const STEP_ERROR_FIELD = 24;
const STEP_INBOUND_MESSAGE = 114;
const STEP_TOOL_RESULT = 140;
const TOOL_RESULT_TEXT = 1;
const TOOL_RESULT_PAYLOAD = 2;
const TOOL_RESULT_ANY = 6;
const INVOKE_SUBAGENT_TYPE_URL = "type.googleapis.com/exa.cortex.core.tools.InvokeSubagent";
const TOOL_STEP_TYPE = 132;
const STEP_TYPE_NAMES: Readonly<Record<number, string>> = {
  14: "USER_INPUT",
  15: "PLANNER_RESPONSE",
  17: "ERROR",
  101: "MESSAGE",
};
const STEP_STATUS_DONE = 3;

/** Where agy keeps conversation databases below the directory the provider hands this reader. */
export const ANTIGRAVITY_CONVERSATION_SEGMENTS = ["antigravity-cli", "conversations"] as const;

// One open reads at most this much; past any bound the child view stays as it was.
const MAX_STEP_BYTES = 1024 * 1024;
const MAX_SCAN_BYTES = 8 * 1024 * 1024;
const MAX_TOOL_STEP_CANDIDATES = 8;
const MAX_CHILD_STEPS = 200;
const MAX_CHILDREN = 16;
const TRANSCRIPT_BYTE_CAP = 256 * 1024;
const BATCH_TRANSCRIPT_BYTES = 512 * 1024;
const STEP_TEXT_CAP = 4_000;
const TOOL_INPUT_CAP = 1_000;

/** T3's title for a subagent call whose launch text it never saw. */
export const ANTIGRAVITY_SUBAGENT_BATCH_TITLE = "Antigravity subagent batch";

interface AntigravityChildLaunch {
  readonly role: string;
  readonly prompt: string;
  readonly model: string | null;
}

const decodeLaunchInput = Schema.decodeUnknownOption(
  Schema.Struct({
    Role: Schema.String,
    Prompt: Schema.String,
    Model: Schema.optional(Schema.String),
  }),
);

/** `invoke_subagent` arguments from the ACP tool call: one subagent per call. */
export function antigravitySubagentLaunches(
  input: unknown,
): ReadonlyArray<AntigravityChildLaunch> | undefined {
  return Option.getOrUndefined(
    Option.map(decodeLaunchInput(input), (decoded) => [
      { role: decoded.Role, prompt: decoded.Prompt, model: decoded.Model ?? null },
    ]),
  );
}

export function describeAntigravitySubagentLaunches(
  launches: ReadonlyArray<AntigravityChildLaunch>,
) {
  const [only] = launches;
  return launches.length === 1 && only !== undefined
    ? { title: only.role, prompt: only.prompt, model: only.model }
    : {
        title: launches.map((launch) => launch.role).join(", "),
        prompt: launches.map((launch) => `${launch.role}\n${launch.prompt}`).join("\n\n"),
        model: null,
      };
}

const NATIVE_ID = /^[A-Za-z0-9-]{1,64}$/;

/** Undefined for steps this reader cannot decode, so they never count as proof. */
const safely =
  <A>(decode: (payload: Uint8Array) => A) =>
  (payload: Uint8Array): A | undefined => {
    try {
      return decode(payload);
    } catch {
      return undefined;
    }
  };

interface InvokeRecord {
  readonly toolCallId: string;
  readonly launches: ReadonlyArray<AntigravityChildLaunch>;
  readonly conversationIds: ReadonlyArray<string>;
}

const toolCallOf = (payload: Uint8Array) =>
  message(message(payload, STEP_METADATA), METADATA_TOOL_CALL);

// Tool step {5: metadata{4: call{1 id, 2 name}}, 140: {2: result{6: Any InvokeSubagent{1: specs
// {1 type, 2 role, 3 prompt, 12 model}, 2: children{1 conversation id}}}}}.
export const decodeInvokeRecord = safely((payload): InvokeRecord | undefined => {
  const toolCallId = text(toolCallOf(payload), 1);
  const any = message(
    message(message(payload, STEP_TOOL_RESULT), TOOL_RESULT_PAYLOAD),
    TOOL_RESULT_ANY,
  );
  if (toolCallId === undefined || any === undefined || text(any, 1) !== INVOKE_SUBAGENT_TYPE_URL) {
    return undefined;
  }
  const invoke = message(any, 2);
  if (invoke === undefined) return undefined;
  const conversationIds = messages(invoke, 2).map((child) => text(child, 1) ?? "");
  if (!conversationIds.every((id) => NATIVE_ID.test(id))) return undefined;
  const launches = messages(invoke, 1).map((spec) => ({
    role: text(spec, 2) ?? "",
    prompt: text(spec, 3) ?? "",
    model: text(spec, 12) ?? null,
  }));
  return launches.length === conversationIds.length && conversationIds.length <= MAX_CHILDREN
    ? { toolCallId, launches, conversationIds }
    : undefined;
});

const payloadOf = (row: unknown) =>
  row !== null &&
  typeof row === "object" &&
  "step_payload" in row &&
  row.step_payload instanceof Uint8Array
    ? row.step_payload
    : undefined;

/**
 * agy numbers a call `call_<digits>` in both the ACP stream and the step's metadata, so the
 * record carrying that exact id in this session's own database is the proof. Candidates are
 * found in the small metadata column; a payload that is oversized or ambiguous proves nothing.
 */
function findInvokeRecord(database: NodeSqlite.DatabaseSync, nativeTaskId: string) {
  const total = database
    .prepare(
      "SELECT coalesce(sum(length(metadata)), 0) AS bytes FROM steps WHERE step_type = ? AND step_format = 0",
    )
    .get(TOOL_STEP_TYPE);
  if (Number(total?.bytes ?? 0) > MAX_SCAN_BYTES) return undefined;
  const matches: Array<InvokeRecord> = [];
  let candidates = 0;
  for (const row of database
    .prepare(
      // SQLite returns only in-bound payloads, so an oversized row never reaches this process.
      "SELECT length(step_payload) AS size, CASE WHEN length(step_payload) <= ? THEN step_payload END AS step_payload FROM steps WHERE step_type = ? AND step_format = 0 AND length(metadata) <= ? AND instr(metadata, CAST(? AS BLOB)) > 0 ORDER BY idx LIMIT ?",
    )
    .iterate(
      MAX_STEP_BYTES,
      TOOL_STEP_TYPE,
      MAX_STEP_BYTES,
      nativeTaskId,
      MAX_TOOL_STEP_CANDIDATES + 1,
    )) {
    candidates += 1;
    const payload = payloadOf(row);
    // An unreadable candidate could be a second record with this id.
    if (candidates > MAX_TOOL_STEP_CANDIDATES || payload === undefined) return undefined;
    const callId = safely((bytes: Uint8Array) => text(toolCallOf(bytes), 1))(payload);
    if (callId !== nativeTaskId) continue;
    const record = decodeInvokeRecord(payload);
    if (record === undefined) return undefined;
    matches.push(record);
  }
  const [match] = matches;
  return matches.length === 1 ? match : undefined;
}

const capText = (value: string, limit: number) =>
  value.length <= limit ? value : `${value.slice(0, limit)}…`;

const decodeChildStep = (
  index: number,
  type: number,
  status: number,
  payload: Uint8Array,
  prompt: string,
) =>
  safely((bytes): OrchestrationV2NativeChildStep | undefined => {
    const step = (
      stepType: string,
      stepText: string | undefined,
      toolCalls: OrchestrationV2NativeChildStep["toolCalls"] = [],
    ) =>
      stepText === undefined && toolCalls.length === 0
        ? undefined
        : {
            index,
            type: stepType,
            status: status === STEP_STATUS_DONE ? "DONE" : null,
            text: stepText === undefined ? null : capText(stepText, STEP_TEXT_CAP),
            toolCalls,
          };
    if (type === 14) return step("USER_INPUT", text(message(bytes, STEP_USER_INPUT_FIELD), 2));
    if (type === 15) {
      const planner = message(bytes, STEP_PLANNER_RESPONSE);
      return step(
        "PLANNER_RESPONSE",
        text(planner, 8) ?? text(planner, 1),
        planner === undefined
          ? []
          : messages(planner, PLANNER_TOOL_CALLS).map((call) => ({
              name: text(call, 2) ?? "",
              input: capText(text(call, 3) ?? "", TOOL_INPUT_CAP),
            })),
      );
    }
    if (type === 17) {
      const error = message(message(bytes, STEP_ERROR_FIELD), 3);
      return step("ERROR", text(error, 9) ?? text(error, 2) ?? text(error, 1));
    }
    if (type === 101) {
      const body = text(message(message(message(bytes, STEP_INBOUND_MESSAGE), 2), 10), 1);
      // The launch prompt is the child's first message, and the view already shows it.
      return body !== undefined && body.trim() === prompt.trim()
        ? undefined
        : step(STEP_TYPE_NAMES[101]!, body);
    }
    const name = text(toolCallOf(bytes), 2);
    if (name === undefined) return undefined;
    return step(
      name.toUpperCase(),
      text(message(message(bytes, STEP_TOOL_RESULT), TOOL_RESULT_PAYLOAD), TOOL_RESULT_TEXT),
    );
  })(payload);

/** The child's newest steps within a byte budget; `truncated` when earlier ones were left out. */
function readChildSteps(database: NodeSqlite.DatabaseSync, prompt: string, byteCap: number) {
  const newestFirst: Array<OrchestrationV2NativeChildStep> = [];
  let rows = 0;
  let scanned = 0;
  let kept = 0;
  let truncated = false;
  for (const row of database
    .prepare(
      "SELECT idx, step_type, status, length(step_payload) AS size, CASE WHEN length(step_payload) <= ? THEN step_payload END AS step_payload FROM steps WHERE step_format = 0 ORDER BY idx DESC LIMIT ?",
    )
    .iterate(MAX_STEP_BYTES, MAX_CHILD_STEPS + 1)) {
    const record = row as Record<string, unknown>;
    rows += 1;
    scanned += Number(record.size ?? 0);
    if (rows > MAX_CHILD_STEPS || scanned > MAX_SCAN_BYTES || kept > byteCap) {
      truncated = true;
      break;
    }
    const payload = payloadOf(record);
    const step =
      payload === undefined
        ? undefined
        : decodeChildStep(
            Number(record.idx),
            Number(record.step_type),
            Number(record.status),
            payload,
            prompt,
          );
    if (step === undefined) continue;
    kept +=
      (step.text?.length ?? 0) + step.toolCalls.reduce((sum, call) => sum + call.input.length, 0);
    newestFirst.push(step);
  }
  return { steps: newestFirst.toReversed(), truncated };
}

const childMetadataBytes = (database: NodeSqlite.DatabaseSync) => {
  const row = database
    .prepare(
      "SELECT CASE WHEN length(data) <= ? THEN data END AS data FROM trajectory_metadata_blob WHERE id = 'main'",
    )
    .get(MAX_STEP_BYTES);
  return row?.data instanceof Uint8Array ? row.data : undefined;
};

/** Reads the child's own conversation, only when it names this session as its parent. */
async function readChild(
  profileRoot: string,
  parentSessionId: string,
  conversationId: string,
  prompt: string,
  byteCap: number,
) {
  const databasePath = (
    await antigravityManagedPath(
      profileRoot,
      [...ANTIGRAVITY_CONVERSATION_SEGMENTS, `${conversationId}.db`],
      "file",
    )
  )?.path;
  if (databasePath === undefined) return undefined;
  const database = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
  try {
    database.exec("PRAGMA busy_timeout = 100");
    // trajectory_metadata_blob.main field 5 is the conversation that spawned this one.
    const metadata = childMetadataBytes(database);
    const parent = metadata === undefined ? undefined : safely((bytes) => text(bytes, 5))(metadata);
    if (parent !== parentSessionId) return undefined;
    return readChildSteps(database, prompt, byteCap);
  } finally {
    database.close();
  }
}

class AntigravityChildWorkReadError extends Schema.TaggedError<AntigravityChildWorkReadError>()(
  "AntigravityChildWorkReadError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not read Antigravity subagent records.";
  }
}

/** The child a subagent tool call launched, proven by the parent's own session record. */
export const readAntigravityChildWork = Effect.fn("readAntigravityChildWork")(function* (input: {
  readonly profileDirectory: string;
  readonly rootSessionId: string;
  readonly nativeTaskId: string;
}) {
  if (!NATIVE_ID.test(input.rootSessionId)) return [];
  return yield* Effect.tryPromise({
    try: async (): Promise<ReadonlyArray<OrchestrationV2NativeChildWork>> => {
      const profileRoot = await antigravityProfileRoot(input.profileDirectory);
      const databasePath =
        profileRoot === undefined
          ? undefined
          : (
              await antigravityManagedPath(
                profileRoot,
                [...ANTIGRAVITY_CONVERSATION_SEGMENTS, `${input.rootSessionId}.db`],
                "file",
              )
            )?.path;
      if (profileRoot === undefined || databasePath === undefined) return [];
      const database = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
      let record: InvokeRecord | undefined;
      try {
        database.exec("PRAGMA busy_timeout = 100");
        record = findInvokeRecord(database, input.nativeTaskId);
      } finally {
        database.close();
      }
      if (record === undefined) return [];
      const { launches, conversationIds } = record;
      // One budget for the whole call, so the response stays small however many children ran.
      const byteCap = Math.min(
        TRANSCRIPT_BYTE_CAP,
        Math.floor(BATCH_TRANSCRIPT_BYTES / Math.max(1, conversationIds.length)),
      );
      return Promise.all(
        conversationIds.map(async (conversationId, index) => {
          const launch = launches[index];
          const child = await readChild(
            profileRoot,
            input.rootSessionId,
            conversationId,
            launch?.prompt ?? "",
            byteCap,
          ).catch(() => undefined);
          return {
            conversationId,
            role: launch?.role ?? "",
            prompt: launch?.prompt ?? "",
            steps: child?.steps ?? null,
            truncated: child?.truncated ?? false,
          };
        }),
      );
    },
    catch: (cause) => new AntigravityChildWorkReadError({ cause }),
  });
});
