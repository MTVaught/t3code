import { EventId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { formatThreadSpend, latestThreadUsage } from "./threadUsage.ts";

function activity(payload: unknown): OrchestrationThreadActivity {
  return {
    id: EventId.make("usage"),
    kind: "context-window.updated",
    tone: "info",
    summary: "Context window updated",
    createdAt: "2026-10-05T00:00:00.000Z",
    turnId: null,
    payload,
  };
}

describe("latestThreadUsage", () => {
  it("keeps the newest valid reading when later payloads are malformed", () => {
    const latest = { usedTokens: 11263, threadSpend: { amount: 0.044804, unit: "Bobcoins" } };
    expect(
      latestThreadUsage([
        activity({ usedTokens: 10 }),
        activity(latest),
        activity({ usedTokens: -1 }),
      ]),
    ).toEqual(latest);
  });

  it("preserves zero usage and rejects negative spend", () => {
    expect(
      latestThreadUsage([
        activity({ usedTokens: 0, threadSpend: { amount: 0, unit: "Bobcoins" } }),
      ]),
    ).toEqual({ usedTokens: 0, threadSpend: { amount: 0, unit: "Bobcoins" } });
    expect(
      latestThreadUsage([
        activity({ usedTokens: 10, threadSpend: { amount: -1, unit: "Bobcoins" } }),
      ]),
    ).toBeNull();
  });

  it("formats fractional coin spend", () => {
    expect(formatThreadSpend({ amount: 0.044804, unit: "Bobcoins" })).toBe("0.0448 Bobcoins");
    expect(formatThreadSpend({ amount: 0, unit: "Bobcoins" })).toBe("0 Bobcoins");
  });
});
