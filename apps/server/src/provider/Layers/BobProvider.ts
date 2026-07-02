/**
 * BobProvider — snapshot + status probe for the IBM Bob provider.
 *
 * Bob exposes a fixed catalog of model tiers (no dynamic discovery endpoint),
 * so the model list is static and the status probe is a simple `bob --version`
 * health check. Bob authenticates via `BOBSHELL_API_KEY` and has no separate
 * auth probe, so auth status is always reported as `unknown`.
 *
 * @module provider/Layers/BobProvider
 */
import {
  type BobSettings,
  DEFAULT_BOB_MODEL,
  type ModelCapabilities,
  ProviderDriverKind,
  type ServerProviderModel,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  buildServerProvider,
  detailFromResult,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import { resolveBobBinary } from "../Drivers/BobEnvironment.ts";

const BOB_PRESENTATION = {
  displayName: "Bob",
  badgeLabel: "Early Access",
  showInteractionModeToggle: false,
  requiresNewThreadForModelChange: false,
} as const;

export const BOB_PROVIDER = ProviderDriverKind.make("bob");

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const VERSION_PROBE_TIMEOUT_MS = 4_000;

/**
 * Bob's selectable models.
 *
 * bob advertises several tier aliases internally (`standard`, `basic`, `fast`,
 * `lite`, `granite-3-3-8b-instruct`), but as of bob v1.0.4 only `premium` is
 * actually usable — every other tier is accepted by `-m` yet crashes the run
 * with `Cannot read properties of undefined (reading 'maxTokens')` and returns
 * `status: "error"`. So only `premium` is advertised here; users who know their
 * account supports another model can still add it via `customModels`.
 */
export const BOB_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: DEFAULT_BOB_MODEL,
    name: "Premium",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
];

/**
 * The set of built-in model slugs, used by the adapter to validate a selected
 * model before passing it to bob via `-m`.
 */
export const BOB_BUILT_IN_MODEL_SLUGS: ReadonlySet<string> = new Set(
  BOB_BUILT_IN_MODELS.map((model) => model.slug),
);

export function bobModelsFromSettings(
  customModels: ReadonlyArray<string> | undefined,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(
    BOB_BUILT_IN_MODELS,
    BOB_PROVIDER,
    customModels ?? [],
    EMPTY_CAPABILITIES,
  );
}

export function buildInitialBobProviderSnapshot(
  bobSettings: BobSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const models = bobModelsFromSettings(bobSettings.customModels);

    if (!bobSettings.enabled) {
      return buildServerProvider({
        presentation: BOB_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Bob is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: BOB_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Bob CLI availability...",
      },
    });
  });
}

const runBobVersionCommand = (bobSettings: BobSettings, environment: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const command = resolveBobBinary(bobSettings);
    const spawnCommand = yield* resolveSpawnCommand(command, ["--version"], {
      env: environment,
    });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

export const checkBobProviderStatus = Effect.fn("checkBobProviderStatus")(function* (
  bobSettings: BobSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const models = bobModelsFromSettings(bobSettings.customModels);

  if (!bobSettings.enabled) {
    return buildServerProvider({
      presentation: BOB_PRESENTATION,
      enabled: false,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Bob is disabled in T3 Code settings.",
      },
    });
  }

  const versionResult = yield* runBobVersionCommand(bobSettings, environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    return buildServerProvider({
      presentation: BOB_PRESENTATION,
      enabled: bobSettings.enabled,
      checkedAt,
      models,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Bob CLI (`bob`) is not installed or not on PATH."
          : `Failed to execute Bob CLI health check: ${error instanceof Error ? error.message : String(error)}.`,
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: BOB_PRESENTATION,
      enabled: bobSettings.enabled,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Bob CLI is installed but timed out while running `bob --version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    const detail = detailFromResult(versionOutput);
    return buildServerProvider({
      presentation: BOB_PRESENTATION,
      enabled: bobSettings.enabled,
      checkedAt,
      models,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: detail
          ? `Bob CLI is installed but failed to run. ${detail}`
          : "Bob CLI is installed but failed to run.",
      },
    });
  }

  return buildServerProvider({
    presentation: BOB_PRESENTATION,
    enabled: bobSettings.enabled,
    checkedAt,
    models,
    probe: {
      installed: true,
      version,
      status: "ready",
      auth: { status: "unknown" },
    },
  });
});
