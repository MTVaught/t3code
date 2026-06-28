/**
 * BobTextGeneration — text generation for the IBM Bob provider.
 *
 * `bob` has no structured-output (`--schema`) flag, so — like the Grok ACP
 * backend — we prompt bob for a JSON object, collect its stream-json output, and
 * parse the result ourselves. Each operation spawns a one-shot
 *
 *   bob -p "<prompt>" -o stream-json -m <tier> --chat-mode ask
 *
 * subprocess. bob streams newline-delimited JSON events; the authoritative final
 * answer is the `attempt_completion` tool's `result` parameter, falling back to
 * the accumulated assistant `message` text when bob answers without a completion
 * call. The JSON object is then extracted from that answer and validated against
 * the operation's schema.
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
import { BOB_BUILT_IN_MODEL_SLUGS } from "../provider/Layers/BobProvider.ts";
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

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseJsonRecord(line: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Extract the human-readable error from a bob `result` event, if present. */
function readBobResultError(event: Record<string, unknown>): string | undefined {
  const error = event.error;
  if (error && typeof error === "object" && !Array.isArray(error)) {
    return readString((error as Record<string, unknown>).message);
  }
  return readString(event.error);
}

interface BobStreamOutcome {
  /** Final answer from `attempt_completion`, the authoritative output. */
  readonly finalAnswer: string | undefined;
  /** Accumulated assistant `message` text — fallback when there is no completion. */
  readonly assistantText: string;
  /** Error surfaced by a non-success `result` event. */
  readonly errorMessage: string | undefined;
}

/**
 * Parse bob's newline-delimited stream-json stdout into the final answer text
 * (and any error). Mirrors the event handling in {@link BobAdapter}: the answer
 * lives in `attempt_completion`, intermediary assistant `message` events are
 * reasoning we only fall back to, and inline `[using tool ...]`/`<thinking>`
 * noise is stripped.
 */
function parseBobStream(stdout: string): BobStreamOutcome {
  let finalAnswer: string | undefined;
  let assistantText = "";
  let errorMessage: string | undefined;

  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const event = parseJsonRecord(line);
    if (!event) continue;

    switch (readString(event.type)) {
      case "tool_use": {
        if (readString(event.tool_name) !== "attempt_completion") break;
        const params = event.parameters;
        const result =
          params && typeof params === "object" && !Array.isArray(params)
            ? readString((params as Record<string, unknown>).result)
            : undefined;
        if (result) finalAnswer = result;
        break;
      }
      case "message": {
        if (readString(event.role) !== "assistant") break;
        const content = readString(event.content);
        if (!content || content.startsWith("[using tool ")) break;
        assistantText += content;
        break;
      }
      case "result": {
        const status = readString(event.status);
        if (status !== undefined && status !== "success") {
          errorMessage = readBobResultError(event);
        }
        break;
      }
      default:
        break;
    }
  }

  return {
    finalAnswer,
    assistantText: assistantText.split("<thinking>").join("").split("</thinking>").join(""),
    errorMessage,
  };
}

/**
 * Resolve the bob model tier from the selection, falling back to bob's default
 * ("premium") when unset or unknown. Mirrors `resolveBobTier` in BobAdapter.
 */
function resolveBobTier(
  modelSelection: ModelSelection,
  customModels: ReadonlyArray<string>,
): string {
  const slug = modelSelection.model;
  if (slug && (BOB_BUILT_IN_MODEL_SLUGS.has(slug) || customModels.includes(slug))) {
    return slug;
  }
  return "premium";
}

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
        (acc, chunk) => acc + chunk,
      ),
      Effect.mapError((cause) =>
        normalizeCliError("bob", operation, cause, "Failed to collect process output"),
      ),
    );

  /**
   * Spawn the bob CLI, parse its stream-json output, and return the parsed,
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
    const tier = resolveBobTier(modelSelection, bobSettings.customModels);

    const runBobCommand = Effect.fn("runBobJson.runBobCommand")(function* () {
      const args = [
        "-p",
        prompt,
        "-o",
        "stream-json",
        "-m",
        tier,
        // `ask` completes non-interactively without granting write or command
        // approval. Bob's built-in attempt_completion tool remains available.
        "--chat-mode",
        "ask",
        ...(bobSettings.maxCoins.trim().length > 0
          ? ["--max-coins", bobSettings.maxCoins.trim()]
          : []),
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

      const outcome = parseBobStream(stdout);

      if (exitCode !== 0) {
        const detail = outcome.errorMessage ?? (stderr.trim() || stdout.trim());
        return yield* new TextGenerationError({
          operation,
          detail:
            detail.length > 0
              ? `Bob CLI command failed: ${detail}`
              : `Bob CLI command failed with code ${exitCode}.`,
        });
      }

      if (outcome.errorMessage) {
        return yield* new TextGenerationError({
          operation,
          detail: `Bob CLI command failed: ${outcome.errorMessage}`,
        });
      }

      const answer = (outcome.finalAnswer ?? outcome.assistantText).trim();
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
