/**
 * BobEnvironment — environment + command resolution helpers for the IBM Bob
 * provider.
 *
 * @module provider/Drivers/BobEnvironment
 */
import type { BobSettings } from "@t3tools/contracts";

/**
 * Resolve the bob executable from settings, falling back to the bare `bob`
 * command on PATH.
 */
export function resolveBobBinary(bobSettings: Pick<BobSettings, "binaryPath">): string {
  return bobSettings.binaryPath || "bob";
}
