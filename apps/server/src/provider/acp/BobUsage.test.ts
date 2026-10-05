import { describe, expect, it } from "vite-plus/test";

import { bobTaskExportToUsage } from "./BobUsage.ts";

describe("Bob task usage", () => {
  const exported = (costs: unknown, id = "root") => ({
    version: 1,
    tasks: [{ task: { id, costs } }],
  });

  it("reports root context and cumulative coin spend without inventing a capacity or token breakdown", () => {
    expect(
      bobTaskExportToUsage(exported({ contextTokens: 11263, cost: 0.044804 }), "root"),
    ).toEqual({
      usedTokens: 11263,
      threadSpend: { amount: 0.044804, unit: "Bobcoins" },
    });
  });

  it("retains zero values and avoids counting child tasks twice", () => {
    expect(
      bobTaskExportToUsage(
        {
          version: 1,
          tasks: [
            { task: { id: "child", costs: { contextTokens: 2000, cost: 1 } } },
            { task: { id: "root", costs: { contextTokens: 0, cost: 0 } } },
          ],
        },
        "root",
      ),
    ).toEqual({ usedTokens: 0, threadSpend: { amount: 0, unit: "Bobcoins" } });
  });

  it("ignores missing, invalid, mismatched, or unsupported exports", () => {
    for (const value of [
      null,
      exported(null),
      exported({ cost: 1 }),
      exported({ contextTokens: -1, cost: 1 }),
      exported({ contextTokens: 1, cost: Infinity }),
      exported({ contextTokens: 1, cost: 1 }, "another-task"),
      { version: 2, tasks: [] },
    ]) {
      expect(bobTaskExportToUsage(value, "root")).toBeUndefined();
    }
  });
});
