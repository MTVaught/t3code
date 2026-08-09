/**
 * BobProvider — snapshot + status probe for the IBM Bob provider.
 *
 * Bob manages model routing internally, so T3 exposes one hidden routing model
 * and never passes it to the CLI. The status probe requires Bob major version
 * 2. Bob owns authentication and has no separate auth probe, so T3 reports
 * auth status as `unknown` and lets real Bob invocations surface failures.
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

const bobPresentation = (settings: BobSettings) =>
  ({
    displayName: "Bob",
    badgeLabel: "Early Access",
    showInteractionModeToggle: false,
    requiresNewThreadForModelChange: false,
    capabilities: {
      modelPicker: false,
      attachments: true,
      approvals: false,
      structuredInput: false,
      steering: false,
      rollback: false,
      providerModes: false,
      commands: false,
      skills: false,
      subagentProgress: "summary",
      tokenUsage: true,
      billingUnits: ["bobcoin"],
      toolAccessCeiling: settings.toolAccessCeiling,
    },
  }) as const;

export const BOB_ADAPTER_CAPABILITIES = {
  sessionModelSwitch: "unsupported",
  conversationRollback: false,
  midTurnSteering: false,
  interactiveApprovals: false,
  structuredUserInput: false,
  t3McpInjection: false,
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
export const BOB_BUILT_IN_MODEL_SLUGS: ReadonlySet<string> = new Set(
  BOB_BUILT_IN_MODELS.map((model) => model.slug),
);

export function bobModelsFromSettings(): ReadonlyArray<ServerProviderModel> {
  return BOB_BUILT_IN_MODELS;
}

export function isCompatibleBob2Version(version: string | null): boolean {
  if (version === null) return false;
  const major = Number.parseInt(version.split(".", 1)[0] ?? "", 10);
  return major === 2;
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
            ? "Bob CLI returned an unknown version. T3 Code requires Bob 2.x."
            : `Bob CLI ${version} is incompatible. T3 Code requires Bob 2.x.`,
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
