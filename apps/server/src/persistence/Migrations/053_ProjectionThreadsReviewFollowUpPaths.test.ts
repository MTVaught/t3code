import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";
import migrateReviewFollowUpPaths from "./053_ProjectionThreadsReviewFollowUpPaths.ts";

it.layer(NodeSqliteClient.layerMemory())("053_ProjectionThreadsReviewFollowUpPaths", (it) => {
  it.effect("adds a null flag column to existing threads and is safe to rerun", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 52 });
      const now = "2026-01-01T00:00:00.000Z";
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          created_at, updated_at
        ) VALUES (
          'thread-1', 'project-1', 'Existing thread',
          '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', ${now}, ${now}
        )
      `;
      yield* runMigrations({ toMigrationInclusive: 53 });
      const migrated = yield* sql<{ readonly reviewFollowUpPaths: string | null }>`
        SELECT review_follow_up_paths_json AS "reviewFollowUpPaths"
        FROM projection_threads WHERE thread_id = 'thread-1'
      `;
      assert.deepEqual(migrated, [{ reviewFollowUpPaths: null }]);
      yield* sql`
        UPDATE projection_threads SET review_follow_up_paths_json = '["src/app.ts"]'
        WHERE thread_id = 'thread-1'
      `;
      yield* migrateReviewFollowUpPaths;
      const rows = yield* sql<{ readonly reviewFollowUpPaths: string | null }>`
        SELECT review_follow_up_paths_json AS "reviewFollowUpPaths"
        FROM projection_threads WHERE thread_id = 'thread-1'
      `;
      assert.deepEqual(rows, [{ reviewFollowUpPaths: '["src/app.ts"]' }]);
    }),
  );
});
