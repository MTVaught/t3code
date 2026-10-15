import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "./Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

// Each group gets its own in-memory database; `it.layer` shares one per group.
const freshDatabase = () => it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));

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

freshDatabase()("ForkSchemaPatches: retired review flags", (it) => {
  it.effect("runs upstream migration 53 and preserves stored review flags", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 52 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name, created_at)
        VALUES (53, 'ProjectionThreadsReviewFollowUpPaths', CURRENT_TIMESTAMP)
      `;
      yield* sql`
        INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
        VALUES ('project', 'Project', '/workspace', '[]', '2026-10-01', '2026-10-01')
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
          created_at, updated_at, review_follow_up_paths_json
        ) VALUES (
          'thread', 'project', 'Thread', '{"instanceId":"bob","model":"bob-managed"}',
          'full-access', 'default', '2026-10-01', '2026-10-01', '["src/app.ts"]'
        )
      `;

      const executed = yield* runMigrations();
      assert.deepStrictEqual(
        executed.map(([id]) => id),
        [53, 54],
      );
      yield* runMigrations();

      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE name = 'pull_request_files_viewed'
      `;
      assert.equal(tables.length, 1);
      const rows = yield* sql<{ readonly paths: string }>`
        SELECT review_follow_up_paths_json AS paths FROM projection_threads WHERE thread_id = 'thread'
      `;
      assert.equal(rows[0]?.paths, '["src/app.ts"]');
      const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`;
      assert.ok(columns.some((column) => column.name === "auto_settle_disabled_at"));
    }),
  );
});
