// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { assert, describe, it } from "@effect/vitest";

import { bobDatabasePath, readBobTaskUsage } from "./BobUsage.ts";

describe("BobUsage", () => {
  it("reads and validates cumulative task usage without writing Bob's database", () => {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-bob-usage-"));
    try {
      const filename = bobDatabasePath({ HOME: home });
      NodeFS.mkdirSync(NodePath.dirname(filename), { recursive: true });
      const database = new NodeSqlite.DatabaseSync(filename);
      database.exec("CREATE TABLE tasks (id TEXT PRIMARY KEY, costs TEXT)");
      database.prepare("INSERT INTO tasks (id, costs) VALUES (?, ?)").run(
        "task-1",
        JSON.stringify({
          input: 12,
          output: 3,
          cacheRead: 4,
          cacheWrite: 5,
          cost: 0.25,
          contextTokens: 15,
        }),
      );
      database.close();

      assert.deepStrictEqual(readBobTaskUsage("task-1", { HOME: home }), {
        bobcoins: 0.25,
        inputTokens: 12,
        outputTokens: 3,
        cacheReadTokens: 4,
        cacheWriteTokens: 5,
        contextTokens: 15,
      });
    } finally {
      NodeFS.rmSync(home, { recursive: true, force: true });
    }
  });

  it("degrades when the database is absent or incompatible", () => {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-bob-usage-"));
    try {
      assert.equal(readBobTaskUsage("missing", { HOME: home }), undefined);
    } finally {
      NodeFS.rmSync(home, { recursive: true, force: true });
    }
  });
});
