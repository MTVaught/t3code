import { BobSettings, ProviderInstanceId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { expect } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import { makeBobTextGeneration } from "./BobTextGeneration.ts";
import * as TextGeneration from "./TextGeneration.ts";

const decodeBobSettings = Schema.decodeSync(BobSettings);

const BobTextGenerationTestLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-bob-text-generation-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

/** Build a single bob stream-json line. */
function streamLine(event: Record<string, unknown>): string {
  return JSON.stringify(event);
}

function makeFakeBobBinary(dir: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const binDir = path.join(dir, "bin");
    const bobPath = path.join(binDir, "bob");
    yield* fs.makeDirectory(binDir, { recursive: true });

    yield* fs.writeFileString(
      bobPath,
      [
        "#!/bin/sh",
        'args="$*"',
        'if [ -n "$T3_FAKE_BOB_ARGS_MUST_CONTAIN" ]; then',
        '  printf "%s" "$args" | grep -F -- "$T3_FAKE_BOB_ARGS_MUST_CONTAIN" >/dev/null || {',
        '    printf "%s\\n" "args missing expected content" >&2',
        "    exit 2",
        "  }",
        "fi",
        'if [ -n "$T3_FAKE_BOB_STDERR" ]; then',
        '  printf "%s\\n" "$T3_FAKE_BOB_STDERR" >&2',
        "fi",
        'printf "%s" "$T3_FAKE_BOB_OUTPUT"',
        'exit "${T3_FAKE_BOB_EXIT_CODE:-0}"',
        "",
      ].join("\n"),
    );
    yield* fs.chmod(bobPath, 0o755);
    return binDir;
  });
}

function withFakeBobEnv<A, E, R>(
  input: {
    output: string;
    exitCode?: number;
    stderr?: string;
    argsMustContain?: string;
    bobConfig?: Partial<BobSettings>;
  },
  effectFn: (textGeneration: TextGeneration.TextGeneration["Service"]) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-bob-text-" });
    const binDir = yield* makeFakeBobBinary(tempDir);
    const previousPath = process.env.PATH;
    const previousOutput = process.env.T3_FAKE_BOB_OUTPUT;
    const previousExitCode = process.env.T3_FAKE_BOB_EXIT_CODE;
    const previousStderr = process.env.T3_FAKE_BOB_STDERR;
    const previousArgsMustContain = process.env.T3_FAKE_BOB_ARGS_MUST_CONTAIN;

    yield* Effect.acquireRelease(
      Effect.sync(() => {
        process.env.PATH = `${binDir}:${previousPath ?? ""}`;
        process.env.T3_FAKE_BOB_OUTPUT = input.output;

        if (input.exitCode !== undefined) {
          process.env.T3_FAKE_BOB_EXIT_CODE = String(input.exitCode);
        } else {
          delete process.env.T3_FAKE_BOB_EXIT_CODE;
        }

        if (input.stderr !== undefined) {
          process.env.T3_FAKE_BOB_STDERR = input.stderr;
        } else {
          delete process.env.T3_FAKE_BOB_STDERR;
        }

        if (input.argsMustContain !== undefined) {
          process.env.T3_FAKE_BOB_ARGS_MUST_CONTAIN = input.argsMustContain;
        } else {
          delete process.env.T3_FAKE_BOB_ARGS_MUST_CONTAIN;
        }
      }),
      () =>
        Effect.sync(() => {
          process.env.PATH = previousPath;

          if (previousOutput === undefined) {
            delete process.env.T3_FAKE_BOB_OUTPUT;
          } else {
            process.env.T3_FAKE_BOB_OUTPUT = previousOutput;
          }

          if (previousExitCode === undefined) {
            delete process.env.T3_FAKE_BOB_EXIT_CODE;
          } else {
            process.env.T3_FAKE_BOB_EXIT_CODE = previousExitCode;
          }

          if (previousStderr === undefined) {
            delete process.env.T3_FAKE_BOB_STDERR;
          } else {
            process.env.T3_FAKE_BOB_STDERR = previousStderr;
          }

          if (previousArgsMustContain === undefined) {
            delete process.env.T3_FAKE_BOB_ARGS_MUST_CONTAIN;
          } else {
            process.env.T3_FAKE_BOB_ARGS_MUST_CONTAIN = previousArgsMustContain;
          }
        }),
    );

    const config = decodeBobSettings({ enabled: true, ...input.bobConfig });
    const textGeneration = yield* makeBobTextGeneration(config);
    return yield* effectFn(textGeneration);
  }).pipe(Effect.scoped);
}

it.layer(BobTextGenerationTestLayer)("BobTextGeneration", (it) => {
  it.effect("generates a commit message from the attempt_completion result", () =>
    withFakeBobEnv(
      {
        output: [
          streamLine({ type: "init", session_id: "00000000-0000-4000-8000-000000000000" }),
          streamLine({
            type: "message",
            role: "assistant",
            content: "<thinking>Summarize the staged change.</thinking>",
          }),
          streamLine({
            type: "tool_use",
            tool_name: "attempt_completion",
            parameters: {
              result: JSON.stringify({ subject: "Add Bob text generation", body: "" }),
            },
          }),
          streamLine({ type: "result", status: "success", stats: { total_tokens: 42 } }),
        ].join("\n"),
        // Non-interactive read-only flags must be present.
        argsMustContain: "stream-json",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/bob",
            stagedSummary: "M apps/server/src/textGeneration/BobTextGeneration.ts",
            stagedPatch: "diff --git a/BobTextGeneration.ts b/BobTextGeneration.ts",
            modelSelection: {
              instanceId: ProviderInstanceId.make("bob"),
              model: "premium",
            },
          });

          expect(generated.subject).toBe("Add Bob text generation");
          expect(generated.body).toBe("");
        }),
    ),
  );

  it.effect("passes read-only chat mode to bob", () =>
    withFakeBobEnv(
      {
        output: [
          streamLine({
            type: "tool_use",
            tool_name: "attempt_completion",
            parameters: { result: JSON.stringify({ title: "Investigate reconnect failures" }) },
          }),
          streamLine({ type: "result", status: "success" }),
        ].join("\n"),
        argsMustContain: "--chat-mode ask",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Investigate reconnect failures after restart.",
            modelSelection: {
              instanceId: ProviderInstanceId.make("bob"),
              model: "premium",
            },
          });

          expect(generated.title).toBe("Investigate reconnect failures");
        }),
    ),
  );

  it.effect("falls back to assistant message text when there is no completion", () =>
    withFakeBobEnv(
      {
        output: [
          streamLine({
            type: "message",
            role: "assistant",
            content: `Here you go: ${JSON.stringify({ branch: "fix-reconnect" })}`,
          }),
          streamLine({ type: "result", status: "success" }),
        ].join("\n"),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateBranchName({
            cwd: process.cwd(),
            message: "Fix reconnect failures.",
            modelSelection: {
              instanceId: ProviderInstanceId.make("bob"),
              model: "premium",
            },
          });

          expect(generated.branch).toBe("fix-reconnect");
        }),
    ),
  );

  it.effect("surfaces a bob result error", () =>
    withFakeBobEnv(
      {
        output: [
          streamLine({
            type: "result",
            status: "error",
            error: { message: "insufficient coins" },
          }),
        ].join("\n"),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const result = yield* textGeneration
            .generateThreadTitle({
              cwd: process.cwd(),
              message: "Name this thread.",
              modelSelection: {
                instanceId: ProviderInstanceId.make("bob"),
                model: "premium",
              },
            })
            .pipe(Effect.result);

          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) {
            expect(result.failure.detail).toContain("insufficient coins");
          }
        }),
    ),
  );

  it.effect("fails when bob exits non-zero", () =>
    withFakeBobEnv(
      {
        output: "",
        stderr: "bob: not authenticated",
        exitCode: 1,
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const result = yield* textGeneration
            .generateThreadTitle({
              cwd: process.cwd(),
              message: "Name this thread.",
              modelSelection: {
                instanceId: ProviderInstanceId.make("bob"),
                model: "premium",
              },
            })
            .pipe(Effect.result);

          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) {
            expect(result.failure.detail).toContain("not authenticated");
          }
        }),
    ),
  );
});
