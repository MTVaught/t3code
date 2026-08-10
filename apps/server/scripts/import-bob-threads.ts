#!/usr/bin/env node

// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalConsole:off - standalone offline migration.
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

type SqlValue = null | string | number | bigint | Uint8Array;
type SqlRow = Record<string, SqlValue>;

interface ImportOptions {
  bobDb: string;
  t3Db: string;
  apply: boolean;
  includeArchived: boolean;
  workspace?: string;
  taskIds: ReadonlySet<string>;
  backupPath?: string;
}

interface BobTask extends SqlRow {
  id: string;
  title: string;
  directory: string;
  git_branch: string | null;
  created_at: number;
  updated_at: number;
  time_archived: number | null;
}

interface BobMessage extends SqlRow {
  id: string;
  role: string;
  data: string;
  created_at: number;
}

interface T3Project extends SqlRow {
  project_id: string;
  workspace_root: string;
  default_model_selection_json: string | null;
}

interface PlannedThread {
  task: BobTask;
  project: T3Project;
  messages: Array<{ id: string; role: "user" | "assistant"; text: string; createdAt: string }>;
  threadId: string;
  modelSelection: unknown;
}

const usage = `Usage:
  node apps/server/scripts/import-bob-threads.ts [options]

Options:
  --bob-db <path>       Bob database (default: ~/.bob/db/bob.db)
  --t3-db <path>        T3 database (default: ~/.t3/userdata/state.sqlite)
  --workspace <path>    Import only tasks for this exact workspace
  --task-id <id>        Import one Bob task; may be repeated
  --include-archived    Include archived Bob tasks
  --backup <path>       Backup destination used with --apply
  --apply               Write the import; otherwise only print a plan
  --help                Show this help

Stop T3 before using --apply. The import is transactional and creates a backup.`;

function expandHome(value: string): string {
  if (value === "~") return homedir();
  return value.startsWith("~/") ? path.join(homedir(), value.slice(2)) : value;
}

function resolvePath(value: string): string {
  const resolved = path.resolve(expandHome(value));
  return existsSync(resolved) ? realpathSync(resolved) : resolved;
}

function nextValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return value;
}

export function parseArgs(args: string[]): ImportOptions | { help: true } {
  let bobDb = path.join(homedir(), ".bob", "db", "bob.db");
  let t3Db = path.join(homedir(), ".t3", "userdata", "state.sqlite");
  let workspace: string | undefined;
  let backupPath: string | undefined;
  let apply = false;
  let includeArchived = false;
  const taskIds = new Set<string>();

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--help":
      case "-h":
        return { help: true };
      case "--apply":
        apply = true;
        break;
      case "--include-archived":
        includeArchived = true;
        break;
      case "--bob-db":
        bobDb = nextValue(args, index, arg);
        index += 1;
        break;
      case "--t3-db":
        t3Db = nextValue(args, index, arg);
        index += 1;
        break;
      case "--workspace":
        workspace = nextValue(args, index, arg);
        index += 1;
        break;
      case "--backup":
        backupPath = nextValue(args, index, arg);
        index += 1;
        break;
      case "--task-id":
        taskIds.add(nextValue(args, index, arg));
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return {
    bobDb: resolvePath(bobDb),
    t3Db: resolvePath(t3Db),
    apply,
    includeArchived,
    ...(workspace ? { workspace: resolvePath(workspace) } : {}),
    taskIds,
    ...(backupPath ? { backupPath: resolvePath(backupPath) } : {}),
  };
}

function requireDatabase(filePath: string, label: string): void {
  if (!existsSync(filePath)) throw new Error(`${label} database does not exist: ${filePath}`);
}

function requireTables(db: DatabaseSync, names: string[], label: string): void {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
    name: string;
  }>;
  const available = new Set(rows.map((row) => row.name));
  const missing = names.filter((name) => !available.has(name));
  if (missing.length > 0) throw new Error(`${label} database is missing: ${missing.join(", ")}`);
}

function timestamp(value: number): string {
  const milliseconds = value < 10_000_000_000 ? value * 1_000 : value;
  const date = new Date(milliseconds);
  if (!Number.isFinite(date.valueOf())) throw new Error(`Invalid Bob timestamp: ${value}`);
  return date.toISOString();
}

function importedId(kind: string, bobDb: string, taskId: string, sourceId = ""): string {
  const digest = createHash("sha256")
    .update(`${bobDb}\0${taskId}\0${sourceId}`)
    .digest("hex")
    .slice(0, 32);
  return `bob-import-${kind}-${digest}`;
}

function readMessageText(raw: string): string | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const content = (parsed as Record<string, unknown>).content;
    return typeof content === "string" ? content : undefined;
  } catch {
    return undefined;
  }
}

function normalizedWorkspace(value: string): string {
  return resolvePath(value);
}

function chooseModelSelection(db: DatabaseSync, project: T3Project): unknown {
  const candidates = [
    project.default_model_selection_json,
    (
      db
        .prepare(
          `SELECT model_selection_json
           FROM projection_threads
           WHERE project_id = ? AND deleted_at IS NULL AND model_selection_json IS NOT NULL
           ORDER BY updated_at DESC LIMIT 1`,
        )
        .get(project.project_id) as { model_selection_json?: string } | undefined
    )?.model_selection_json,
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next source. Schema validation on T3 startup catches no imported fallback data.
    }
  }
  return { instanceId: "bob", model: "premium" };
}

function makePlan(bob: DatabaseSync, t3: DatabaseSync, options: ImportOptions): PlannedThread[] {
  const projects = t3
    .prepare(
      `SELECT project_id, workspace_root, default_model_selection_json
       FROM projection_projects WHERE deleted_at IS NULL`,
    )
    .all() as T3Project[];
  const projectsByWorkspace = new Map(
    projects.map((project) => [normalizedWorkspace(project.workspace_root), project]),
  );
  const tasks = bob
    .prepare(
      `SELECT id, title, directory, git_branch, created_at, updated_at, time_archived
       FROM tasks
       WHERE parent_id IS NULL AND task_type = 'normal'
       ORDER BY created_at, id`,
    )
    .all() as BobTask[];

  const plan: PlannedThread[] = [];
  for (const task of tasks) {
    if (!options.includeArchived && task.time_archived !== null) continue;
    if (options.taskIds.size > 0 && !options.taskIds.has(task.id)) continue;
    const taskWorkspace = normalizedWorkspace(task.directory);
    if (options.workspace && taskWorkspace !== options.workspace) continue;
    const project = projectsByWorkspace.get(taskWorkspace);
    if (!project) continue;

    const threadId = importedId("thread", options.bobDb, task.id);
    const alreadyImported = t3
      .prepare("SELECT 1 FROM orchestration_events WHERE event_id = ?")
      .get(importedId("created", options.bobDb, task.id));
    if (alreadyImported) continue;

    const bobMessages = bob
      .prepare(
        `SELECT id, role, data, created_at FROM messages
         WHERE task_id = ? ORDER BY created_at, id`,
      )
      .all(task.id) as BobMessage[];
    const messages = bobMessages.flatMap((message) => {
      if (message.role !== "user" && message.role !== "assistant") return [];
      const text = readMessageText(message.data);
      if (text === undefined) return [];
      return [
        {
          id: message.id,
          role: message.role as "user" | "assistant",
          text,
          createdAt: timestamp(message.created_at),
        },
      ];
    });
    if (messages.length === 0) continue;
    plan.push({
      task,
      project,
      messages,
      threadId,
      modelSelection: chooseModelSelection(t3, project),
    });
  }
  return plan;
}

function insertEvent(
  db: DatabaseSync,
  input: {
    eventId: string;
    threadId: string;
    streamVersion: number;
    type: string;
    occurredAt: string;
    payload: unknown;
    metadata: unknown;
  },
): void {
  db.prepare(
    `INSERT INTO orchestration_events (
       event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
       command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json
     ) VALUES (?, 'thread', ?, ?, ?, ?, NULL, NULL, NULL, 'provider', ?, ?)`,
  ).run(
    input.eventId,
    input.threadId,
    input.streamVersion,
    input.type,
    input.occurredAt,
    JSON.stringify(input.payload),
    JSON.stringify(input.metadata),
  );
}

function applyPlan(t3: DatabaseSync, plan: PlannedThread[], bobDb: string): void {
  t3.exec("BEGIN IMMEDIATE");
  try {
    for (const item of plan) {
      const createdAt = timestamp(item.task.created_at);
      const updatedAt = timestamp(item.task.updated_at);
      const metadata = { source: "bob-import", bobTaskId: item.task.id };
      insertEvent(t3, {
        eventId: importedId("created", bobDb, item.task.id),
        threadId: item.threadId,
        streamVersion: 0,
        type: "thread.created",
        occurredAt: createdAt,
        payload: {
          threadId: item.threadId,
          projectId: item.project.project_id,
          title: item.task.title.trim() || "Imported Bob thread",
          modelSelection: item.modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          providerMode: null,
          branch: item.task.git_branch?.trim() || null,
          worktreePath: null,
          createdAt,
          updatedAt,
        },
        metadata,
      });
      item.messages.forEach((message, index) => {
        insertEvent(t3, {
          eventId: importedId("message-event", bobDb, item.task.id, message.id),
          threadId: item.threadId,
          streamVersion: index + 1,
          type: "thread.message-sent",
          occurredAt: message.createdAt,
          payload: {
            threadId: item.threadId,
            messageId: importedId("message", bobDb, item.task.id, message.id),
            role: message.role,
            text: message.text,
            turnId: null,
            streaming: false,
            createdAt: message.createdAt,
            updatedAt: message.createdAt,
          },
          metadata,
        });
      });
      if (item.task.time_archived !== null) {
        const archivedAt = timestamp(item.task.time_archived);
        insertEvent(t3, {
          eventId: importedId("archived", bobDb, item.task.id),
          threadId: item.threadId,
          streamVersion: item.messages.length + 1,
          type: "thread.archived",
          occurredAt: archivedAt,
          payload: { threadId: item.threadId, archivedAt, updatedAt: archivedAt },
          metadata,
        });
      }
    }
    t3.exec("COMMIT");
  } catch (error) {
    t3.exec("ROLLBACK");
    throw error;
  }
}

export async function runImport(options: ImportOptions): Promise<{
  threads: number;
  messages: number;
  backup?: string;
}> {
  requireDatabase(options.bobDb, "Bob");
  requireDatabase(options.t3Db, "T3");
  const bob = new DatabaseSync(options.bobDb, { readOnly: true });
  const t3 = new DatabaseSync(options.t3Db, { readOnly: !options.apply });
  try {
    requireTables(bob, ["tasks", "messages"], "Bob");
    requireTables(t3, ["orchestration_events", "projection_projects", "projection_threads"], "T3");
    const plan = makePlan(bob, t3, options);
    const result = {
      threads: plan.length,
      messages: plan.reduce((sum, item) => sum + item.messages.length, 0),
    };
    if (!options.apply || plan.length === 0) return result;

    const destination =
      options.backupPath ??
      `${options.t3Db}.backup-bob-import-${new Date().toISOString().replaceAll(":", "-")}`;
    if (existsSync(destination)) throw new Error(`Backup already exists: ${destination}`);
    await backup(t3, destination);
    applyPlan(t3, plan, options.bobDb);
    return { ...result, backup: destination };
  } finally {
    bob.close();
    t3.close();
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if ("help" in options) {
    console.log(usage);
    return;
  }
  const result = await runImport(options);
  console.log(
    `${options.apply ? "Imported" : "Would import"} ${result.threads} thread(s) and ${result.messages} message(s).`,
  );
  if (result.backup) console.log(`Backup: ${result.backup}`);
  if (!options.apply) console.log("No changes made. Pass --apply after stopping T3.");
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
