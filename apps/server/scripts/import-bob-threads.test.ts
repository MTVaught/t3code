// @effect-diagnostics nodeBuiltinImport:off - tests use disposable SQLite files.
import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { ThreadCreatedPayload, ThreadMessageSentPayload } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { parseArgs, runImport } from "./import-bob-threads.ts";

function fixture(): { root: string; bobDb: string; t3Db: string; workspace: string } {
  const root = mkdtempSync(path.join(tmpdir(), "t3-bob-import-"));
  const bobDb = path.join(root, "bob.db");
  const t3Db = path.join(root, "state.sqlite");
  const workspace = path.join(root, "project");
  const bob = new DatabaseSync(bobDb);
  bob.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, directory TEXT NOT NULL,
      git_branch TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      time_archived INTEGER, parent_id TEXT, task_type TEXT NOT NULL
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, role TEXT NOT NULL,
      data TEXT NOT NULL, created_at INTEGER NOT NULL
    );
  `);
  bob
    .prepare("INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 'normal')")
    .run(
      "0123456789abcdef0123456789abcdef",
      "Imported task",
      workspace,
      "feature/bob",
      1_700_000_000_000,
      1_700_000_003_000,
    );
  const insertMessage = bob.prepare("INSERT INTO messages VALUES (?, ?, ?, ?, ?)");
  insertMessage.run(
    "m1",
    "0123456789abcdef0123456789abcdef",
    "system",
    '{"content":"hidden"}',
    1_700_000_000_000,
  );
  insertMessage.run(
    "m2",
    "0123456789abcdef0123456789abcdef",
    "user",
    '{"content":"hello"}',
    1_700_000_001_000,
  );
  insertMessage.run(
    "m3",
    "0123456789abcdef0123456789abcdef",
    "assistant",
    '{"content":"hi"}',
    1_700_000_002_000,
  );
  insertMessage.run(
    "m4",
    "0123456789abcdef0123456789abcdef",
    "tool",
    '{"content":"secret output"}',
    1_700_000_003_000,
  );
  bob.close();

  const t3 = new DatabaseSync(t3Db);
  t3.exec(`
    CREATE TABLE orchestration_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE,
      aggregate_kind TEXT NOT NULL, stream_id TEXT NOT NULL, stream_version INTEGER NOT NULL,
      event_type TEXT NOT NULL, occurred_at TEXT NOT NULL, command_id TEXT,
      causation_event_id TEXT, correlation_id TEXT, actor_kind TEXT NOT NULL,
      payload_json TEXT NOT NULL, metadata_json TEXT NOT NULL,
      UNIQUE (aggregate_kind, stream_id, stream_version)
    );
    CREATE TABLE projection_projects (
      project_id TEXT PRIMARY KEY, workspace_root TEXT NOT NULL,
      default_model_selection_json TEXT, deleted_at TEXT
    );
    CREATE TABLE projection_threads (
      thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, model_selection_json TEXT,
      updated_at TEXT NOT NULL, deleted_at TEXT
    );
  `);
  t3.prepare("INSERT INTO projection_projects VALUES (?, ?, ?, NULL)").run(
    "project-1",
    workspace,
    '{"instanceId":"codex","model":"gpt-5.6-sol"}',
  );
  t3.close();
  return { root, bobDb, t3Db, workspace };
}

describe("import-bob-threads", () => {
  it("is a dry run unless --apply is passed", async () => {
    const input = fixture();
    const options = parseArgs(["--bob-db", input.bobDb, "--t3-db", input.t3Db]);
    assert.ok(!("help" in options));
    assert.deepEqual(await runImport(options), { threads: 1, messages: 2 });
    const t3 = new DatabaseSync(input.t3Db, { readOnly: true });
    assert.equal(t3.prepare("SELECT count(*) AS count FROM orchestration_events").get()!.count, 0);
    t3.close();
  });

  it("backs up and appends canonical, deduplicated events", async () => {
    const input = fixture();
    const backupPath = path.join(input.root, "backup.sqlite");
    const options = parseArgs([
      "--bob-db",
      input.bobDb,
      "--t3-db",
      input.t3Db,
      "--backup",
      backupPath,
      "--apply",
    ]);
    assert.ok(!("help" in options));
    assert.deepEqual(await runImport(options), { threads: 1, messages: 2, backup: backupPath });

    const t3 = new DatabaseSync(input.t3Db, { readOnly: true });
    const events = t3
      .prepare(
        "SELECT event_type, payload_json, stream_version FROM orchestration_events ORDER BY sequence",
      )
      .all() as Array<{ event_type: string; payload_json: string; stream_version: number }>;
    assert.deepEqual(
      events.map((event) => event.event_type),
      ["thread.created", "thread.message-sent", "thread.message-sent"],
    );
    assert.deepEqual(
      events.map((event) => event.stream_version),
      [0, 1, 2],
    );
    assert.deepEqual(
      events.slice(1).map((event) => JSON.parse(event.payload_json).text),
      ["hello", "hi"],
    );
    assert.doesNotThrow(() =>
      Schema.decodeUnknownSync(ThreadCreatedPayload)(JSON.parse(events[0]!.payload_json)),
    );
    for (const event of events.slice(1)) {
      assert.doesNotThrow(() =>
        Schema.decodeUnknownSync(ThreadMessageSentPayload)(JSON.parse(event.payload_json)),
      );
    }
    t3.close();
    assert.ok(new DatabaseSync(backupPath, { readOnly: true }));

    assert.deepEqual(await runImport(options), { threads: 0, messages: 0 });
  });
});
