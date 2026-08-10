/**
 * BobEnvironment — environment + command resolution helpers for the IBM Bob
 * provider.
 *
 * Bob authenticates via `BOB_API_KEY`. A configured key overrides the server
 * process environment; an empty setting preserves Bob's ambient environment
 * and login behavior.
 *
 * @module provider/Drivers/BobEnvironment
 */
import type { BobSettings } from "@t3tools/contracts";

/**
 * Build the process environment for a Bob invocation, layering a configured
 * API key over the provided base environment.
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
