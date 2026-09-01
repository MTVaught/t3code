import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "./Migrations.ts";
import * as NodeSqliteClient from "./NodeSqliteClient.ts";

// Each group gets its own in-memory database; `it.layer` shares one per group.
const freshDatabase = () => it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

freshDatabase()("ForkSchemaPatches: provider mode column", (it) => {
  it.effect("adds the provider mode column after migrations run, idempotently", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations();
      yield* runMigrations();

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      assert.equal(columns.filter((column) => column.name === "provider_mode").length, 1);
    }),
  );
});

freshDatabase()("ForkSchemaPatches: retired migration rows", (it) => {
  it.effect("drops a retired fork migration row so upstream's migration with that id runs", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 40 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name, created_at)
        VALUES (41, 'ProjectionThreadsProviderMode', CURRENT_TIMESTAMP)
      `;

      const executed = yield* runMigrations({ toMigrationInclusive: 42 });

      assert.deepStrictEqual(
        executed.map(([id]) => id),
        [41, 42],
      );
      const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id >= 41
        ORDER BY migration_id
      `;
      assert.deepStrictEqual(rows, [
        { migration_id: 41, name: "AuthSessionClientConnection" },
        { migration_id: 42, name: "ProjectionThreadLinkedPullRequest" },
      ]);
      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      assert.ok(columns.some((column) => column.name === "provider_mode"));
    }),
  );
});
