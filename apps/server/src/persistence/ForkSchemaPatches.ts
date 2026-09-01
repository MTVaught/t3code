/**
 * ForkSchemaPatches - schema additions owned by this fork, applied outside the
 * numbered migration manifest.
 *
 * The Effect migrator skips every migration whose id is <= the highest id
 * recorded in `effect_sql_migrations`. A fork-numbered migration therefore
 * collides with upstream's next migration of the same id, and any id higher
 * than upstream's would permanently block upstream migrations. Fork schema
 * changes are instead idempotent patches that run after every migration pass,
 * and rows a previous fork build recorded under a numbered id are removed so
 * upstream's migration with that id still runs.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Names this fork previously registered in the migration manifest. */
const RETIRED_FORK_MIGRATION_NAMES = ["ProjectionThreadsProviderMode"] as const;

export const removeStaleForkMigrationRows = Effect.fn("removeStaleForkMigrationRows")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{ readonly name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
    `;
  if (tables.length === 0) return;
  const removed = yield* sql<{ readonly migration_id: number; readonly name: string }>`
      DELETE FROM effect_sql_migrations
      WHERE name IN ${sql.in([...RETIRED_FORK_MIGRATION_NAMES])}
      RETURNING migration_id, name
    `;
  if (removed.length > 0) {
    yield* Effect.log("Removed retired fork migration rows").pipe(
      Effect.annotateLogs({
        migrations: removed.map((row) => `${row.migration_id}_${row.name}`),
      }),
    );
  }
});

const ensureProviderModeColumn = Effect.fn("ensureProviderModeColumn")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`;
  if (columns.length === 0) return;
  if (!columns.some((column) => column.name === "provider_mode")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN provider_mode TEXT`;
  }
});

export const applyForkSchemaPatches = Effect.fn("applyForkSchemaPatches")(function* () {
  yield* ensureProviderModeColumn();
});
