/**
 * BobTextGeneration — text generation for the IBM Bob provider.
 *
 * MVP stub: bob has no structured-output (`--schema`) flag, so commit/PR/branch/
 * title generation is deferred. Each method fails with a clear
 * {@link TextGenerationError} so callers degrade gracefully (the UI surfaces the
 * message rather than hanging). A full implementation would prompt bob for JSON
 * and parse the final `attempt_completion` result.
 *
 * @module textGeneration/BobTextGeneration
 */
import * as Effect from "effect/Effect";

import { type BobSettings, TextGenerationError } from "@t3tools/contracts";
import * as TextGeneration from "./TextGeneration.ts";

const NOT_SUPPORTED_DETAIL = "Text generation is not yet supported for the Bob provider.";

const fail = (operation: string) =>
  Effect.fail(new TextGenerationError({ operation, detail: NOT_SUPPORTED_DETAIL }));

export const makeBobTextGeneration = (
  _bobSettings: BobSettings,
  _environment?: NodeJS.ProcessEnv,
): Effect.Effect<TextGeneration.TextGeneration["Service"]> =>
  Effect.succeed({
    generateCommitMessage: () => fail("generateCommitMessage"),
    generatePrContent: () => fail("generatePrContent"),
    generateBranchName: () => fail("generateBranchName"),
    generateThreadTitle: () => fail("generateThreadTitle"),
  } satisfies TextGeneration.TextGeneration["Service"]);
