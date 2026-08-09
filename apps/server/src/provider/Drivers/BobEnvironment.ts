/**
 * BobEnvironment — environment + command resolution helpers for the IBM Bob
 * provider.
 *
 * Bob 2 authenticates via `BOB_API_KEY` and still accepts the legacy
 * `BOBSHELL_API_KEY`. Configured credentials use the current name; an
 * unconfigured instance inherits either ambient variable and Bob's own login.
 *
 * @module provider/Drivers/BobEnvironment
 */
import type { BobSettings } from "@t3tools/contracts";

/**
 * Build the process environment for a Bob invocation, layering the configured
 * API key (if any) on top of the provided base environment.
 */
export function makeBobEnvironment(
  bobSettings: BobSettings,
  environment?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const base = environment ?? process.env;
  const apiKey = bobSettings.apiKey.trim();
  return {
    ...base,
    ...(apiKey.length > 0 ? { BOB_API_KEY: apiKey } : {}),
  } satisfies NodeJS.ProcessEnv;
}

/**
 * Resolve the bob executable from settings, falling back to the bare `bob`
 * command on PATH.
 */
export function resolveBobBinary(bobSettings: BobSettings): string {
  return bobSettings.binaryPath || "bob";
}
