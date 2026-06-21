/**
 * BobEnvironment — environment + command resolution helpers for the IBM Bob
 * provider.
 *
 * `bob` authenticates via the `BOBSHELL_API_KEY` environment variable. When the
 * user configures an explicit `apiKey` in settings we inject it; otherwise we
 * inherit whatever is already on the ambient environment (the common case for a
 * machine where `bob` is already logged in).
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
    ...(apiKey.length > 0 ? { BOBSHELL_API_KEY: apiKey } : {}),
  } satisfies NodeJS.ProcessEnv;
}

/**
 * Resolve the bob executable from settings, falling back to the bare `bob`
 * command on PATH.
 */
export function resolveBobBinary(bobSettings: BobSettings): string {
  return bobSettings.binaryPath || "bob";
}
