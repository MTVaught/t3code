/**
 * BobEnvironment — environment + command resolution helpers for the IBM Bob
 * provider.
 *
 * Bob owns its authentication. T3 passes the server process environment (plus
 * generic provider-instance environment overrides) through unchanged and does
 * not collect, validate, or inject Bob credentials.
 *
 * @module provider/Drivers/BobEnvironment
 */
import type { BobSettings } from "@t3tools/contracts";

/**
 * Build the process environment for a Bob invocation without adding
 * provider-specific authentication state.
 */
export function makeBobEnvironment(environment?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return environment ?? process.env;
}

/**
 * Resolve the bob executable from settings, falling back to the bare `bob`
 * command on PATH.
 */
export function resolveBobBinary(bobSettings: BobSettings): string {
  return bobSettings.binaryPath || "bob";
}
