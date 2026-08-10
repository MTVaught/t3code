import type { RuntimeMode, ServerProviderToolAccessCeiling } from "@t3tools/contracts";

export type EffectiveToolAccess = ServerProviderToolAccessCeiling;

const ACCESS_RANK: Record<EffectiveToolAccess, number> = {
  "read-only": 0,
  edits: 1,
  full: 2,
};

export function runtimeModeToolAccess(runtimeMode: RuntimeMode): EffectiveToolAccess {
  if (runtimeMode === "approval-required") return "read-only";
  if (runtimeMode === "full-access") return "full";
  return "edits";
}

export function effectiveToolAccess(
  runtimeMode: RuntimeMode,
  ceiling: ServerProviderToolAccessCeiling | undefined,
): EffectiveToolAccess {
  const runtimeAccess = runtimeModeToolAccess(runtimeMode);
  if (!ceiling || ACCESS_RANK[runtimeAccess] <= ACCESS_RANK[ceiling]) return runtimeAccess;
  return ceiling;
}

export function formatToolAccess(access: EffectiveToolAccess): string {
  if (access === "read-only") return "read-only";
  if (access === "edits") return "edits only";
  return "full access";
}
