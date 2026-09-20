import type { CommandId, GitRunStackedActionResult, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";

import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";

/**
 * A commit is the end of "follow up on this file": clear the review flags for
 * the paths a stacked action committed, or all of them when it took the whole
 * working tree. Never fails; the git action already succeeded.
 */
export const clearCommittedReviewFlags = <E>(input: {
  readonly threadId: ThreadId;
  readonly result: Pick<GitRunStackedActionResult, "commit">;
  readonly filePaths: ReadonlyArray<string> | undefined;
  readonly commandId: Effect.Effect<CommandId, E>;
}): Effect.Effect<void, never, OrchestrationEngine.OrchestrationEngineService> =>
  Effect.gen(function* () {
    if (input.result.commit.status !== "created") return;
    if (input.filePaths !== undefined && input.filePaths.length === 0) return;
    const engine = yield* OrchestrationEngine.OrchestrationEngineService;
    const commandId = yield* input.commandId;
    yield* engine
      .dispatch({
        type: "thread.review-file.unflag",
        commandId,
        threadId: input.threadId,
        ...(input.filePaths === undefined ? {} : { paths: [...input.filePaths] }),
      })
      .pipe(Effect.catchTags({ OrchestrationCommandInvariantError: () => Effect.void }));
  }).pipe(
    Effect.withSpan("clearCommittedReviewFlags"),
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause as Cause.Cause<never>)
        : Effect.logWarning("failed to clear review flags after commit", {
            threadId: input.threadId,
          }),
    ),
  );
