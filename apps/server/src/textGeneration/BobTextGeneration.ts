/**
 * BobTextGeneration — text generation for the IBM Bob provider.
 *
 * `bob` has no structured-output (`--schema`) flag, so — like the Grok ACP
 * backend — we prompt Bob for a JSON object, collect its bounded JSON output, and
 * parse the result ourselves. Each operation spawns a one-shot
 *
 *   bob run --format json --workspace <cwd> --mode ask <prompt>
 *
 * subprocess. The result's `last_message` is extracted and validated against the
 * operation schema. All mutating and external tool groups are disabled.
 *
 * @module textGeneration/BobTextGeneration
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { type BobSettings, type ModelSelection, TextGenerationError } from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { extractJsonObject } from "@t3tools/shared/schemaJson";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import { makeBobEnvironment, resolveBobBinary } from "../provider/Drivers/BobEnvironment.ts";
import {
  BOB2_PROTOCOL_LIMITS,
  classifyBob2StartupFailure,
  decodeBob2Line,
} from "../provider/Bob2Protocol.ts";
import * as TextGeneration from "./TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import {
  normalizeCliError,
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";

const BOB_TIMEOUT_MS = 180_000;

type TextGenerationOperation =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle";

const BOB_JSON_OUTPUT_LIMIT = BOB2_PROTOCOL_LIMITS.lineCharacters;

export const makeBobTextGeneration = Effect.fn("makeBobTextGeneration")(function* (
  bobSettings: BobSettings,
  environment?: NodeJS.ProcessEnv,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const bobEnvironment = makeBobEnvironment(bobSettings, environment);
  const binary = resolveBobBinary(bobSettings);

  const readStreamAsString = <E>(
    operation: TextGenerationOperation,
    stream: Stream.Stream<Uint8Array, E>,
  ): Effect.Effect<string, TextGenerationError> =>
    stream.pipe(
      Stream.decodeText(),
      Stream.runFold(
        () => "",
        (acc, chunk) => `${acc}${chunk}`.slice(0, BOB_JSON_OUTPUT_LIMIT),
      ),
      Effect.mapError((cause) =>
        normalizeCliError("bob", operation, cause, "Failed to collect process output"),
      ),
    );

  /**
   * Spawn the Bob CLI, parse its JSON output, and return the parsed,
   * schema-validated structured result.
   */
  const runBobJson = Effect.fn("runBobJson")(function* <S extends Schema.Top>({
    operation,
    cwd,
    prompt,
    outputSchema,
    modelSelection,
  }: {
    operation: TextGenerationOperation;
    cwd: string;
    prompt: string;
    outputSchema: S;
    modelSelection: ModelSelection;
  }): Effect.fn.Return<S["Type"], TextGenerationError, S["DecodingServices"]> {
    void modelSelection;

    const runBobCommand = Effect.fn("runBobJson.runBobCommand")(function* () {
      const args = [
        "run",
        "--format",
        "json",
        "--workspace",
        cwd,
        "--mode",
        "ask",
        "--disable-mcp",
        "--disable-subagents",
        "--disable-tool-groups",
        "edit,execute,browser,mode,mcp,subagent",
        ...(bobSettings.teamId ? ["--team-id", bobSettings.teamId] : []),
        ...(bobSettings.taskCostThresholdBobcoins !== undefined
          ? ["--max-cost", String(bobSettings.taskCostThresholdBobcoins)]
          : []),
        ...(bobSettings.maxTurns !== undefined
          ? ["--max-turns", String(bobSettings.maxTurns)]
          : []),
        prompt,
      ];
      const spawnCommand = yield* resolveSpawnCommand(binary, args, { env: bobEnvironment });
      const command = ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: bobEnvironment,
        cwd,
        shell: spawnCommand.shell,
      });

      const child = yield* spawner
        .spawn(command)
        .pipe(
          Effect.mapError((cause) =>
            normalizeCliError("bob", operation, cause, "Failed to spawn Bob CLI process"),
          ),
        );

      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          readStreamAsString(operation, child.stdout),
          readStreamAsString(operation, child.stderr),
          child.exitCode.pipe(
            Effect.mapError((cause) =>
              normalizeCliError("bob", operation, cause, "Failed to read Bob CLI exit code"),
            ),
          ),
        ],
        { concurrency: "unbounded" },
      );

      const outcome = decodeBob2Line(stdout.trim());

      if (exitCode !== 0) {
        const detail = classifyBob2StartupFailure(stderr.trim() || stdout.trim()).message;
        return yield* new TextGenerationError({
          operation,
          detail:
            detail.length > 0
              ? `Bob CLI command failed: ${detail}`
              : `Bob CLI command failed with code ${exitCode}.`,
        });
      }

      if (outcome.type !== "result" || outcome.status !== "success") {
        return yield* new TextGenerationError({
          operation,
          detail:
            outcome.type === "result" && outcome.errorMessage
              ? `Bob CLI command failed: ${outcome.errorMessage}`
              : "Bob CLI returned an invalid or unsuccessful result.",
        });
      }

      const answer = outcome.lastMessage?.trim() ?? "";
      if (answer.length === 0) {
        return yield* new TextGenerationError({
          operation,
          detail: "Bob returned empty output.",
        });
      }

      return answer;
    });

    const answer = yield* runBobCommand().pipe(
      Effect.scoped,
      Effect.timeoutOption(BOB_TIMEOUT_MS),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new TextGenerationError({ operation, detail: "Bob CLI request timed out." }),
            ),
          onSome: (value) => Effect.succeed(value),
        }),
      ),
    );

    const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(outputSchema));
    return yield* decodeOutput(extractJsonObject(answer)).pipe(
      Effect.catchTags({
        SchemaError: (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation,
              detail: "Bob returned invalid structured output.",
              cause,
            }),
          ),
      }),
    );
  });

  // ---------------------------------------------------------------------------
  // TextGeneration service methods
  // ---------------------------------------------------------------------------

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("BobTextGeneration.generateCommitMessage")(function* (input) {
      const { prompt, outputSchema } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
      });

      const generated = yield* runBobJson({
        operation: "generateCommitMessage",
        cwd: input.cwd,
        prompt,
        outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        subject: sanitizeCommitSubject(generated.subject),
        body: generated.body.trim(),
        ...("branch" in generated && typeof generated.branch === "string"
          ? { branch: sanitizeFeatureBranchName(generated.branch) }
          : {}),
      };
    });

  const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] =
    Effect.fn("BobTextGeneration.generatePrContent")(function* (input) {
      const { prompt, outputSchema } = buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
      });

      const generated = yield* runBobJson({
        operation: "generatePrContent",
        cwd: input.cwd,
        prompt,
        outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        title: sanitizePrTitle(generated.title),
        body: generated.body.trim(),
      };
    });

  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] =
    Effect.fn("BobTextGeneration.generateBranchName")(function* (input) {
      const { prompt, outputSchema } = buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
      });

      const generated = yield* runBobJson({
        operation: "generateBranchName",
        cwd: input.cwd,
        prompt,
        outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        branch: sanitizeBranchFragment(generated.branch),
      };
    });

  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
    Effect.fn("BobTextGeneration.generateThreadTitle")(function* (input) {
      const { prompt, outputSchema } = buildThreadTitlePrompt({
        message: input.message,
        attachments: input.attachments,
      });

      const generated = yield* runBobJson({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        prompt,
        outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        title: sanitizeThreadTitle(generated.title),
      } satisfies TextGeneration.ThreadTitleGenerationResult;
    });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGeneration.TextGeneration["Service"];
});
