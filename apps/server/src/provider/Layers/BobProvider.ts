/**
 * BobProvider — snapshot + status probe for the IBM Bob provider.
 *
 * Bob manages model routing internally, so T3 exposes one hidden routing model
 * and never passes it to the CLI. The status probe requires Bob 2.0.1 or newer.
 * Bob authenticates through its ACP authentication method, so
 * auth status is reported as `unknown` until a real invocation runs.
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
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import { resolveBobBinary } from "../Drivers/BobEnvironment.ts";

const bobPresentation = (_settings: BobSettings) =>
  ({
    displayName: "Bob",
    badgeLabel: "Early Access",
    showInteractionModeToggle: false,
    requiresNewThreadForModelChange: false,
    capabilities: {
      modelPicker: false,
      attachments: true,
      approvals: true,
      structuredInput: false,
      steering: false,
      rollback: false,
      providerModes: true,
      commands: true,
      skills: false,
      subagentProgress: "summary",
      tokenUsage: false,
    },
  }) as const;

export const BOB_ADAPTER_CAPABILITIES = {
  sessionModelSwitch: "unsupported",
  conversationRollback: false,
  midTurnSteering: false,
  interactiveApprovals: true,
  structuredUserInput: false,
  t3McpInjection: true,
  attachments: true,
} as const;

export const BOB_PROVIDER = ProviderDriverKind.make("bob");

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const VERSION_PROBE_TIMEOUT_MS = 4_000;

/**
 * Bob's provider-routing sentinel. Bob 2 chooses the actual model itself.
 */
export const BOB_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: DEFAULT_BOB_MODEL,
    name: "Bob managed",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
];

/**
 * Kept for persisted model-selection compatibility. The adapter never passes
 * this slug to Bob.
 */
export const BOB_BUILT_IN_MODEL_SLUGS: ReadonlySet<string> = new Set([
  ...BOB_BUILT_IN_MODELS.map((model) => model.slug),
  "premium",
]);

export function bobModelsFromSettings(): ReadonlyArray<ServerProviderModel> {
  return BOB_BUILT_IN_MODELS;
}

export function isCompatibleBob2Version(version: string | null): boolean {
  if (version === null) return false;
  const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);
  if (![major, minor, patch].every(Number.isFinite)) return false;
  return major > 2 || (major === 2 && (minor > 0 || patch >= 1));
}

export function buildInitialBobProviderSnapshot(
  bobSettings: BobSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const models = bobModelsFromSettings();

    if (!bobSettings.enabled) {
      return buildServerProvider({
        presentation: bobPresentation(bobSettings),
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
      presentation: bobPresentation(bobSettings),
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
  const models = bobModelsFromSettings();

  if (!bobSettings.enabled) {
    return buildServerProvider({
      presentation: bobPresentation(bobSettings),
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
      presentation: bobPresentation(bobSettings),
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
      presentation: bobPresentation(bobSettings),
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
      presentation: bobPresentation(bobSettings),
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

  if (!isCompatibleBob2Version(version)) {
    return buildServerProvider({
      presentation: bobPresentation(bobSettings),
      enabled: bobSettings.enabled,
      checkedAt,
      models,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message:
          version === null
            ? "Bob CLI returned an unknown version. T3 Code requires Bob 2.0.1 or newer."
            : `Bob CLI ${version} is incompatible. T3 Code requires Bob 2.0.1 or newer.`,
      },
    });
  }

  return buildServerProvider({
    presentation: bobPresentation(bobSettings),
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
