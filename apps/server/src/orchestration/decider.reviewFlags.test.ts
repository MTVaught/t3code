import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
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

const single = <T>(value: T | ReadonlyArray<T>): T => {
  const events = Array.isArray(value) ? value : [value];
  expect(events).toHaveLength(1);
  return events[0] as T;
};

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
      if (event.type === "thread.review-file-flagged") {
        expect(event.payload.paths).toEqual(["src/app.ts"]);
        expect(event.payload.updatedAt).toBe(NOW);
      }
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
      if (event.type === "thread.review-file-flagged") {
        expect(event.payload.updatedAt).toBe(EARLIER);
      }
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
      if (event.type === "thread.review-file-unflagged") {
        expect(event.payload.paths).toEqual(["src/app.ts"]);
        expect(event.payload.updatedAt).toBe(NOW);
      }
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
      if (event.type === "thread.review-file-unflagged") {
        expect(event.payload.paths).toEqual(["src/app.ts", "src/other.ts"]);
      }
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
      if (event.type === "thread.review-file-unflagged") {
        expect(event.payload.paths).toEqual([]);
        expect(event.payload.updatedAt).toBe(EARLIER);
      }
    }),
  );
});
