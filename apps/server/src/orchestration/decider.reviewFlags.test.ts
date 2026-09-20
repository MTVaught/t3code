import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  ThreadReviewFileFlaggedPayload,
  ThreadReviewFileUnflaggedPayload,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

// The Effect test clock starts at the epoch.
const NOW = "1970-01-01T00:00:00.000Z";
const EARLIER = "1969-12-30T00:00:00.000Z";

function makeReadModel(reviewFollowUpPaths: ReadonlyArray<string>): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [
      {
        id: ThreadId.make("thread-1"),
        projectId: ProjectId.make("project-1"),
        title: "Thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        pullRequests: [],
        latestTurn: null,
        createdAt: EARLIER,
        updatedAt: EARLIER,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        reviewFollowUpPaths,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: null,
      },
    ],
    updatedAt: EARLIER,
  };
}

type DecidedEvent = Omit<OrchestrationEvent, "sequence">;

const single = (value: DecidedEvent | ReadonlyArray<DecidedEvent>): DecidedEvent => {
  const events = Array.isArray(value) ? value : [value as DecidedEvent];
  expect(events).toHaveLength(1);
  return events[0] as DecidedEvent;
};
// The decider's event type is not a distributive union, so payloads are decoded explicitly.
const flaggedPayload = Schema.decodeUnknownSync(ThreadReviewFileFlaggedPayload);
const unflaggedPayload = Schema.decodeUnknownSync(ThreadReviewFileUnflaggedPayload);

it.layer(NodeServices.layer)("review flag decider", (it) => {
  it.effect("flags a file and stamps updatedAt", () =>
    Effect.gen(function* () {
      const event = single(
        yield* decideOrchestrationCommand({
          command: {
            type: "thread.review-file.flag",
            commandId: CommandId.make("cmd-flag"),
            threadId: ThreadId.make("thread-1"),
            paths: ["src/app.ts"],
          },
          readModel: makeReadModel([]),
        }),
      );
      expect(event.type).toBe("thread.review-file-flagged");
      const payload = flaggedPayload(event.payload);
      expect(payload.paths).toEqual(["src/app.ts"]);
      expect(payload.updatedAt).toBe(NOW);
    }),
  );

  it.effect("re-flagging a flagged file preserves updatedAt", () =>
    Effect.gen(function* () {
      const event = single(
        yield* decideOrchestrationCommand({
          command: {
            type: "thread.review-file.flag",
            commandId: CommandId.make("cmd-flag-again"),
            threadId: ThreadId.make("thread-1"),
            paths: ["src/app.ts"],
          },
          readModel: makeReadModel(["src/app.ts"]),
        }),
      );
      const payload = flaggedPayload(event.payload);
      expect(payload.updatedAt).toBe(EARLIER);
    }),
  );

  it.effect("unflagging resolves to the paths that were actually flagged", () =>
    Effect.gen(function* () {
      const event = single(
        yield* decideOrchestrationCommand({
          command: {
            type: "thread.review-file.unflag",
            commandId: CommandId.make("cmd-unflag"),
            threadId: ThreadId.make("thread-1"),
            paths: ["src/app.ts", "src/never-flagged.ts"],
          },
          readModel: makeReadModel(["src/app.ts", "src/other.ts"]),
        }),
      );
      expect(event.type).toBe("thread.review-file-unflagged");
      const payload = unflaggedPayload(event.payload);
      expect(payload.paths).toEqual(["src/app.ts"]);
      expect(payload.updatedAt).toBe(NOW);
    }),
  );

  it.effect("unflagging without paths clears every flag on the thread", () =>
    Effect.gen(function* () {
      const event = single(
        yield* decideOrchestrationCommand({
          command: {
            type: "thread.review-file.unflag",
            commandId: CommandId.make("cmd-unflag-all"),
            threadId: ThreadId.make("thread-1"),
          },
          readModel: makeReadModel(["src/app.ts", "src/other.ts"]),
        }),
      );
      const payload = unflaggedPayload(event.payload);
      expect(payload.paths).toEqual(["src/app.ts", "src/other.ts"]);
    }),
  );

  it.effect("unflagging with nothing flagged preserves updatedAt", () =>
    Effect.gen(function* () {
      const event = single(
        yield* decideOrchestrationCommand({
          command: {
            type: "thread.review-file.unflag",
            commandId: CommandId.make("cmd-unflag-noop"),
            threadId: ThreadId.make("thread-1"),
          },
          readModel: makeReadModel([]),
        }),
      );
      const payload = unflaggedPayload(event.payload);
      expect(payload.paths).toEqual([]);
      expect(payload.updatedAt).toBe(EARLIER);
    }),
  );
});
