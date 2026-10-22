import { BobSettings, BobSettingsConfig, ProviderDriverKind } from "@t3tools/contracts";
import {
  makeAcpRegistryDriver,
  type AcpRegistryDriverEnv,
} from "@t3tools/provider-acp-registry/server";
import { AcpRegistrySettings } from "@t3tools/provider-acp-registry/settings";
import type { ProviderDriver } from "@t3tools/provider-core/server/driver";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { makeBobTextGeneration } from "../../textGeneration/BobTextGeneration.ts";
import { resolveBobBinary } from "./BobEnvironment.ts";

const DRIVER_KIND = ProviderDriverKind.make("bob");
const acpDriver = makeAcpRegistryDriver({ driverKind: DRIVER_KIND, supportsTextGeneration: true });
const decodeSettings = Schema.decodeSync(BobSettings);
const decodeAcpSettings = Schema.decodeSync(AcpRegistrySettings);

export type BobDriverEnv = AcpRegistryDriverEnv;

/** Bob's chat uses upstream ACP discovery, authentication, modes, commands, and lifecycle. */
export const BobDriver: ProviderDriver<BobSettings, BobDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "Bob", supportsMultipleInstances: true },
  configSchema: BobSettingsConfig,
  defaultConfig: () => decodeSettings({}),
  create: (input) =>
    Effect.gen(function* () {
      const instance = yield* acpDriver.create({
        ...input,
        config: decodeAcpSettings({
          source: "local",
          commandPath: resolveBobBinary(input.config),
          commandArgs: ["acp"],
          authMethodId: "sso",
        }),
      });
      const environment = yield* mergeProviderInstanceEnvironment(input.environment);
      const textGeneration = yield* makeBobTextGeneration(
        { ...input.config, enabled: input.enabled },
        environment,
      );
      return { ...instance, textGeneration };
    }),
};
