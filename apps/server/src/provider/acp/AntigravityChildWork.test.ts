import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  antigravitySubagentLaunches,
  describeAntigravitySubagentLaunches,
  readAntigravityChildWork,
} from "./AntigravityChildWork.ts";
import {
  CALL_ID,
  CHILD,
  childSteps,
  invokeStep,
  LAUNCH,
  launched,
  makeProfile,
  plannerStep,
  ROOT,
  toolStep,
  writeConversation,
} from "./AntigravityChildWork.testkit.ts";

const read = (profileDirectory: string, nativeTaskId = CALL_ID) =>
  readAntigravityChildWork({ profileDirectory, rootSessionId: ROOT, nativeTaskId });

it("reads the launch from the ACP tool input, one subagent per call", () => {
  const launches = antigravitySubagentLaunches({
    Model: LAUNCH.model,
    Prompt: LAUNCH.prompt,
    Role: LAUNCH.role,
    TypeName: "self",
  });
  expect(launches).toEqual([{ ...LAUNCH, model: "Gemini Flash Lite" }]);
  expect(describeAntigravitySubagentLaunches(launches!)).toEqual({
    title: LAUNCH.role,
    prompt: LAUNCH.prompt,
    model: "Gemini Flash Lite",
  });
  expect(antigravitySubagentLaunches({ Subagents: [] })).toBeUndefined();
});

it("labels agy's subagent model tiers and drops the inherited one", () => {
  const modelOf = (Model: string) =>
    antigravitySubagentLaunches({ Model, Prompt: "p", Role: "r" })?.[0]?.model;
  expect(modelOf("flash_lite")).toBe("Gemini Flash Lite");
  expect(modelOf("pro")).toBe("Gemini Pro");
  expect(modelOf("inherit")).toBeNull();
  expect(modelOf("gemini-x")).toBe("gemini-x");
});

it.layer(NodeServices.layer)("readAntigravityChildWork", (it) => {
  it.effect("follows the call id to the parent's record and reads the child's own work", () =>
    Effect.gen(function* () {
      const { profile } = yield* makeProfile({ steps: launched, child: { steps: childSteps } });
      const [child, ...rest] = yield* read(profile);
      expect(rest).toEqual([]);
      expect(child).toMatchObject({
        conversationId: CHILD,
        role: LAUNCH.role,
        prompt: LAUNCH.prompt,
        truncated: false,
      });
      // The launch prompt arrives as the child's first message, which the view already shows.
      expect(child?.steps).toEqual([
        {
          index: 1,
          type: "PLANNER_RESPONSE",
          status: "DONE",
          text: null,
          toolCalls: [{ name: "read_file", input: '{"Path":"/project/README.md"}' }],
        },
        {
          index: 2,
          type: "READ_FILE",
          status: "DONE",
          text: "2: child read marker 4242",
          toolCalls: [],
        },
        {
          index: 3,
          type: "PLANNER_RESPONSE",
          status: "DONE",
          text: "marker 4242 found",
          toolCalls: [],
        },
      ]);
    }),
  );

  it.effect("needs the exact call id in a decodable subagent record", () =>
    Effect.gen(function* () {
      const twin = invokeStep({ callId: CALL_ID, launches: [LAUNCH], children: [CHILD] });
      const cases = [
        // A shorter id is a substring of the real one, a tool that is not a subagent launch.
        { steps: launched, id: CALL_ID.slice(0, -2) },
        { steps: launched, id: "call_other" },
        // Two records claim one id, so neither is proven.
        { steps: [...launched, twin], id: CALL_ID },
        { steps: [toolStep({ callId: CALL_ID, name: "read_file" })], id: CALL_ID },
        { steps: [plannerStep({ text: CALL_ID })], id: CALL_ID },
        // A record whose call matches but whose payload does not decode.
        {
          steps: [{ ...twin, payload: Uint8Array.from([0xff, 0xff]) }],
          id: CALL_ID,
        },
        // More launches than children is not a complete record.
        {
          steps: [invokeStep({ callId: CALL_ID, launches: [LAUNCH, LAUNCH], children: [CHILD] })],
          id: CALL_ID,
        },
      ];
      for (const { steps, id } of cases) {
        const { profile } = yield* makeProfile({ steps, child: { steps: childSteps } });
        expect(yield* read(profile, id)).toEqual([]);
      }
    }),
  );

  it.effect("shows the launch without steps when the child does not name this parent", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stranger = yield* makeProfile({
        steps: launched,
        child: { parent: "00000000-0000-4000-8000-000000000000", steps: childSteps },
      });
      expect((yield* read(stranger.profile))[0]).toMatchObject({ role: LAUNCH.role, steps: null });

      const absent = yield* makeProfile({ steps: launched });
      expect((yield* read(absent.profile))[0]).toMatchObject({
        conversationId: CHILD,
        steps: null,
      });

      // The child's database links to another session's records.
      const linked = yield* makeProfile({ steps: launched });
      const peer = path.join(linked.conversations, "b468c0e1-d2f3-4a5b-8c7d-8e9f0a1b2c3d.db");
      writeConversation(peer, childSteps, { parent: ROOT });
      yield* fs.symlink(peer, path.join(linked.conversations, `${CHILD}.db`));
      expect((yield* read(linked.profile))[0]?.steps).toBeNull();

      // The parent's own database is a link.
      const other = yield* makeProfile({ steps: launched, child: { steps: childSteps } });
      const moved = path.join(other.conversations, "00000000-0000-4000-8000-000000000000.db");
      yield* fs.rename(path.join(other.conversations, `${ROOT}.db`), moved);
      yield* fs.symlink(moved, path.join(other.conversations, `${ROOT}.db`));
      expect(yield* read(other.profile)).toEqual([]);
    }),
  );

  it.effect("declines records it cannot weigh within its bounds", () =>
    Effect.gen(function* () {
      const oversized = {
        ...invokeStep({ callId: CALL_ID, launches: [LAUNCH], children: [CHILD] }),
        payload: new Uint8Array(1024 * 1024 + 1),
      };
      const { profile } = yield* makeProfile({
        steps: [oversized],
        child: { steps: childSteps },
      });
      expect(yield* read(profile)).toEqual([]);
    }),
  );

  it.effect("keeps only the newest steps and caps their size", () =>
    Effect.gen(function* () {
      const long = "x".repeat(10_000);
      const many = Array.from({ length: 300 }, (_, index) =>
        plannerStep({ text: index === 299 ? "last" : `step ${index} ${long}` }),
      );
      const { profile } = yield* makeProfile({ steps: launched, child: { steps: many } });
      const [child] = yield* read(profile);
      expect(child?.truncated).toBe(true);
      expect(child?.steps?.at(-1)?.text).toBe("last");
      expect(child?.steps?.[0]?.text?.length).toBeLessThanOrEqual(4_001);
      expect(child?.steps?.length).toBeLessThan(200);
      expect(JSON.stringify(child).length).toBeLessThan(300 * 1024);
    }),
  );
});
