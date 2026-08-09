// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

export interface BobCumulativeUsage {
  readonly bobcoins?: number | undefined;
  readonly inputTokens?: number | undefined;
  readonly outputTokens?: number | undefined;
  readonly cacheReadTokens?: number | undefined;
  readonly cacheWriteTokens?: number | undefined;
  readonly contextTokens?: number | undefined;
}

function finiteNonNegative(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function bobDatabasePath(environment: NodeJS.ProcessEnv): string {
  const home = environment.HOME?.trim() || NodeOS.homedir();
  const directory = environment.NODE_ENV === "development" ? "dev-db" : "db";
  return NodePath.join(home, ".bob", directory, "bob.db");
}

export function readBobTaskUsage(
  taskId: string,
  environment: NodeJS.ProcessEnv,
): BobCumulativeUsage | undefined {
  let database: NodeSqlite.DatabaseSync | undefined;
  try {
    database = new NodeSqlite.DatabaseSync(bobDatabasePath(environment), { readOnly: true });
    database.exec("PRAGMA busy_timeout = 100");
    const table = database
      .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'tasks'")
      .get() as Record<string, unknown> | undefined;
    if (!table) return undefined;
    const columns = database.prepare("PRAGMA table_info(tasks)").all() as Array<
      Record<string, unknown>
    >;
    if (
      !columns.some((column) => column.name === "id") ||
      !columns.some((column) => column.name === "costs")
    )
      return undefined;
    const row = database.prepare("SELECT costs FROM tasks WHERE id = ? LIMIT 1").get(taskId) as
      | Record<string, unknown>
      | undefined;
    if (typeof row?.costs !== "string") return undefined;
    const parsed = JSON.parse(row.costs) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const costs = parsed as Record<string, unknown>;
    return {
      ...(finiteNonNegative(costs, "cost") !== undefined
        ? { bobcoins: finiteNonNegative(costs, "cost") }
        : {}),
      ...(finiteNonNegative(costs, "input") !== undefined
        ? { inputTokens: finiteNonNegative(costs, "input") }
        : {}),
      ...(finiteNonNegative(costs, "output") !== undefined
        ? { outputTokens: finiteNonNegative(costs, "output") }
        : {}),
      ...(finiteNonNegative(costs, "cacheRead") !== undefined
        ? { cacheReadTokens: finiteNonNegative(costs, "cacheRead") }
        : {}),
      ...(finiteNonNegative(costs, "cacheWrite") !== undefined
        ? { cacheWriteTokens: finiteNonNegative(costs, "cacheWrite") }
        : {}),
      ...(finiteNonNegative(costs, "contextTokens") !== undefined
        ? { contextTokens: finiteNonNegative(costs, "contextTokens") }
        : {}),
    };
  } catch {
    return undefined;
  } finally {
    database?.close();
  }
}
