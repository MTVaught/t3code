import Constants from "expo-constants";
import { relayClerkTokenOptions } from "@t3tools/shared/relayAuth";
import { normalizeSecureRelayUrl } from "@t3tools/shared/relayUrl";
import * as Schema from "effect/Schema";

export class CloudPublicConfigMissingError extends Schema.TaggedErrorClass<CloudPublicConfigMissingError>()(
  "CloudPublicConfigMissingError",
  {
    key: Schema.Literal("T3CODE_CLERK_JWT_TEMPLATE"),
  },
) {
  override get message(): string {
    return `${this.key} is not configured.`;
  }
}

export interface CloudPublicConfig {
  readonly clerk: {
    readonly publishableKey: string | null;
    readonly jwtTemplate: string | null;
  };
  readonly relay: {
    readonly url: string | null;
  };
}

type UntrustedSection<T> = {
  readonly [Key in keyof T]?: unknown;
};

type ExpoExtra =
  | {
      readonly [Section in keyof CloudPublicConfig]?: UntrustedSection<CloudPublicConfig[Section]>;
    }
  | undefined;

function trimNonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function resolveCloudPublicConfig(extra: ExpoExtra = Constants.expoConfig?.extra) {
  return {
    clerk: {
      publishableKey: trimNonEmpty(extra?.clerk?.publishableKey),
      jwtTemplate: trimNonEmpty(extra?.clerk?.jwtTemplate),
    },
    relay: {
      url: normalizeSecureRelayUrl(trimNonEmpty(extra?.relay?.url) ?? ""),
    },
  } satisfies CloudPublicConfig;
}

// Compliance kill switch: T3 Connect (relay / cloud) is not permitted in this
// environment, so cloud UI and relay auth are force-disabled regardless of
// build configuration. See CLOUD_FEATURE_DISABLED in apps/server and apps/web.
const CLOUD_FEATURE_DISABLED: boolean = true;

export function hasCloudPublicConfig(): boolean {
  const config = resolveCloudPublicConfig();
  return (
    !CLOUD_FEATURE_DISABLED &&
    Boolean(config.clerk.publishableKey && config.clerk.jwtTemplate && config.relay.url)
  );
}

export function resolveRelayClerkTokenOptions() {
  const { jwtTemplate } = resolveCloudPublicConfig().clerk;
  if (!jwtTemplate) {
    throw new CloudPublicConfigMissingError({ key: "T3CODE_CLERK_JWT_TEMPLATE" });
  }
  return relayClerkTokenOptions(jwtTemplate);
}
