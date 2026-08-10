/**
 * BobAdapter — provider adapter for the IBM Bob CLI (`bob`).
 *
 * Unlike the long-lived process adapters (Codex app-server, Cursor/Grok ACP),
 * `bob` has no persistent stdio protocol. Each turn is a fresh one-shot
 * subprocess:
 *
 *   bob run --format stream-json --workspace <cwd> --mode <mode> <prompt>
 *
 * The subprocess streams newline-delimited JSON events to stdout, which this
 * adapter parses and maps into canonical {@link ProviderRuntimeEvent}s. Cross-
 * turn continuity is achieved by capturing the terminal Bob task id and
 * replaying it with `--resume` on the next turn.
 *
 * Headless constraints:
 *   - No interactive approvals: bob runs under a fixed approval mode
 *     (runtime mode and instance ceiling). `respondToRequest`/`respondToUserInput` are
 *     inert — the adapter never opens approval/user-input requests.
 *   - One turn at a time: a one-shot process cannot be steered, so a second
 *     `sendTurn` while a turn is running is rejected.
 *   - Conversation rollback is rejected because Bob cannot fork or rewind tasks.
 *
 * @module provider/Layers/BobAdapter
 */
import {
  type BobSettings,
  type ChatAttachment,
  type CanonicalItemType,
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type RuntimeTurnState,
  RuntimeItemId,
  RuntimeTaskId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { makeBobEnvironment, resolveBobBinary } from "../Drivers/BobEnvironment.ts";
import { discoverBobModes } from "../Drivers/BobModes.ts";
import { BOB_ADAPTER_CAPABILITIES } from "./BobProvider.ts";
import { type BobAdapterShape } from "../Services/BobAdapter.ts";
import {
  Bob2StreamDecoder,
  boundedStderrTail,
  classifyBob2StartupFailure,
  isBob2TaskId,
  reconcileBob2LastMessage,
  type Bob2DecodedEvent,
  type Bob2ResultEvent,
  type Bob2ToolResultEvent,
  type Bob2ToolUseEvent,
} from "../Bob2Protocol.ts";
import { readBobTaskUsage, type BobCumulativeUsage } from "../BobUsage.ts";
import { resolveAttachmentPath } from "../../attachmentStore.ts";

const PROVIDER = ProviderDriverKind.make("bob");
const STDERR_TAIL_LIMIT = 4_000;

interface BobToolInFlight {
  readonly itemId: string;
  readonly itemType: CanonicalItemType;
  readonly toolName: string;
  /** The tool's request parameters, retained so the completed event can carry
   * the input even when bob's `tool_result.output` is empty. */
  readonly parameters: unknown;
  readonly taskId?: RuntimeTaskId;
}

interface BobTurnState {
  readonly turnId: TurnId;
  /** Item id for the streamed assistant answer. */
  readonly assistantItemId: string;
  /** Lazily-created item id for the model's intermediary reasoning stream. */
  reasoningItemId: string | undefined;
  reasoningText: string;
  emittedReasoningDelta: boolean;
  reasoningCompleted: boolean;
  /** Assistant deltas assembled for terminal reconciliation. */
  finalAnswer: string | undefined;
  emittedAssistantDelta: boolean;
  assistantCompleted: boolean;
  completed: boolean;
  interrupted: boolean;
  observedError: string | undefined;
  sawProtocolEvent: boolean;
  result: { readonly state: RuntimeTurnState; readonly errorMessage?: string } | undefined;
  terminalResult: Bob2ResultEvent | undefined;
  stagingDirectory: string | undefined;
  readonly tools: Map<string, BobToolInFlight>;
  readonly items: Array<unknown>;
}

interface BobSessionContext {
  session: ProviderSession;
  resumeTaskId: string | undefined;
  continuationError: string | undefined;
  turnState: BobTurnState | undefined;
  processFiber: Fiber.Fiber<void> | undefined;
  child: ChildProcessSpawner.ChildProcessHandle | undefined;
  cumulativeUsage: BobCumulativeUsage;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  stopped: boolean;
}

export interface BobAdapterLiveOptions {
  readonly instanceId?: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
  readonly attachmentsDir?: string;
}

function readCumulativeUsage(value: unknown): BobCumulativeUsage {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const number = (key: string) => {
    const candidate = record[key];
    return typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0
      ? candidate
      : undefined;
  };
  return {
    ...(number("bobcoins") !== undefined ? { bobcoins: number("bobcoins") } : {}),
    ...(number("inputTokens") !== undefined ? { inputTokens: number("inputTokens") } : {}),
    ...(number("outputTokens") !== undefined ? { outputTokens: number("outputTokens") } : {}),
    ...(number("cacheReadTokens") !== undefined
      ? { cacheReadTokens: number("cacheReadTokens") }
      : {}),
    ...(number("cacheWriteTokens") !== undefined
      ? { cacheWriteTokens: number("cacheWriteTokens") }
      : {}),
    ...(number("contextTokens") !== undefined ? { contextTokens: number("contextTokens") } : {}),
  };
}

function switchedBobMode(tool: BobToolInFlight): string | undefined {
  if (tool.toolName !== "switch_mode" || !tool.parameters || typeof tool.parameters !== "object") {
    return undefined;
  }
  const parameters = tool.parameters as Record<string, unknown>;
  for (const key of ["mode", "mode_slug", "modeSlug", "slug"]) {
    const value = parameters[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readRecordString(value: unknown, ...keys: ReadonlyArray<string>): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const found = readString(record[key]);
    if (found) return found;
  }
  return undefined;
}

function stripTaskResultWrapper(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const match = /^<task_result>\s*([\s\S]*?)\s*<\/task_result>$/.exec(trimmed);
  return (match?.[1] ?? trimmed).slice(0, 16_000).trim() || undefined;
}

function attachmentExtension(attachment: ChatAttachment): string {
  if (/\.[a-zA-Z0-9]{1,10}$/.test(attachment.name)) return "";
  switch (attachment.mimeType.toLowerCase()) {
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    default:
      return "";
  }
}

function trimmedOrUndefined(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Classify a bob tool name into a canonical lifecycle item type. Affects only
 * how the work-log row renders.
 */
function classifyToolItemType(toolName: string): CanonicalItemType {
  const normalized = toolName.toLowerCase();
  if (
    normalized.includes("new_task") ||
    normalized.includes("subagent") ||
    normalized.includes("agent")
  ) {
    return "collab_agent_tool_call";
  }
  if (
    normalized.includes("command") ||
    normalized.includes("execute") ||
    normalized.includes("bash") ||
    normalized.includes("shell") ||
    normalized.includes("terminal")
  ) {
    return "command_execution";
  }
  if (
    normalized.includes("write") ||
    normalized.includes("edit") ||
    normalized.includes("diff") ||
    normalized.includes("apply") ||
    normalized.includes("insert") ||
    normalized.includes("create")
  ) {
    return "file_change";
  }
  if (normalized.includes("mcp")) {
    return "mcp_tool_call";
  }
  if (
    normalized.includes("browser") ||
    normalized.includes("web") ||
    normalized.includes("search")
  ) {
    return "web_search";
  }
  return "dynamic_tool_call";
}

function titleForItemType(itemType: CanonicalItemType): string {
  switch (itemType) {
    case "command_execution":
      return "Command run";
    case "file_change":
      return "File change";
    case "mcp_tool_call":
      return "MCP tool call";
    case "collab_agent_tool_call":
      return "Subagent task";
    case "web_search":
      return "Web search";
    case "image_view":
      return "Image view";
    default:
      return "Tool call";
  }
}

function readBobToolCommand(parameters: unknown): string | undefined {
  if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) {
    return undefined;
  }
  const record = parameters as Record<string, unknown>;
  const command = readString(record.command) ?? readString(record.cmd);
  const trimmed = command?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function summarizeToolRequest(toolName: string, parameters: unknown): string {
  if (parameters && typeof parameters === "object" && !Array.isArray(parameters)) {
    const record = parameters as Record<string, unknown>;
    // bob tools use a variety of parameter keys (e.g. `file_path`, `dir_path`).
    // Surface the most informative one so the work-log row reads cleanly instead
    // of dumping raw JSON.
    const highlight =
      readBobToolCommand(parameters) ??
      readString(record.file_path) ??
      readString(record.path) ??
      readString(record.file) ??
      readString(record.filename) ??
      readString(record.absolute_path) ??
      readString(record.dir_path) ??
      readString(record.pattern) ??
      readString(record.query) ??
      readString(record.url);
    if (highlight) {
      return `${toolName}: ${highlight.trim().slice(0, 400)}`;
    }
  }
  let serialized = toolName;
  try {
    serialized = `${toolName}: ${JSON.stringify(parameters)}`;
  } catch {
    serialized = toolName;
  }
  return serialized.length > 400 ? `${serialized.slice(0, 397)}...` : serialized;
}

/**
 * Resolve the bob model tier from the model selection, falling back to bob's
 * default ("premium") when unset or unknown.
 */
function resolveBobChatMode(
  interactionMode: "default" | "plan" | undefined,
  providerMode?: string,
): string {
  if (interactionMode === "plan") return "plan";
  return providerMode ?? "agent";
}

const READ_ONLY_GROUPS = ["edit", "execute", "mcp", "subagent", "browser", "mode"] as const;
const EDIT_GROUPS = ["execute", "mcp", "subagent", "browser", "mode"] as const;

function disabledBobToolGroups(
  runtimeMode: ProviderSession["runtimeMode"],
  ceiling: BobSettings["toolAccessCeiling"],
): ReadonlyArray<string> {
  const runtimeGroups =
    runtimeMode === "approval-required"
      ? READ_ONLY_GROUPS
      : runtimeMode === "full-access"
        ? []
        : EDIT_GROUPS;
  const ceilingGroups =
    ceiling === "read-only" ? READ_ONLY_GROUPS : ceiling === "edits" ? EDIT_GROUPS : [];
  return [...new Set([...runtimeGroups, ...ceilingGroups])];
}

/** @internal */
export function buildBobTurnArgs(input: {
  readonly prompt: string;
  readonly workspace: string;
  readonly mode: string;
  readonly runtimeMode: ProviderSession["runtimeMode"];
  readonly toolAccessCeiling: BobSettings["toolAccessCeiling"];
  readonly resumeTaskId?: string;
  readonly teamId?: string;
  readonly taskCostThresholdBobcoins?: number;
  readonly maxTurns?: number;
}): ReadonlyArray<string> {
  const disabledGroups = disabledBobToolGroups(input.runtimeMode, input.toolAccessCeiling);
  return [
    "run",
    "--format",
    "stream-json",
    "--workspace",
    input.workspace,
    "--mode",
    input.mode,
    ...(input.resumeTaskId ? ["--resume", input.resumeTaskId] : []),
    ...(input.teamId ? ["--team-id", input.teamId] : []),
    ...(input.taskCostThresholdBobcoins !== undefined
      ? ["--max-cost", String(input.taskCostThresholdBobcoins)]
      : []),
    ...(input.maxTurns !== undefined ? ["--max-turns", String(input.maxTurns)] : []),
    ...(disabledGroups.includes("mcp") ? ["--disable-mcp"] : []),
    ...(disabledGroups.includes("subagent") ? ["--disable-subagents"] : []),
    ...(disabledGroups.length > 0 ? ["--disable-tool-groups", disabledGroups.join(",")] : []),
    input.prompt,
  ];
}

function turnStateFromBobStatus(status: string | undefined): RuntimeTurnState {
  return status === "success" ? "completed" : "failed";
}

export const makeBobAdapter = Effect.fn("makeBobAdapter")(function* (
  bobConfig: BobSettings,
  options?: BobAdapterLiveOptions,
) {
  const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("bob");
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const adapterScope = yield* Effect.scope;
  const bobEnvironment = makeBobEnvironment(bobConfig, options?.environment);
  const binary = resolveBobBinary(bobConfig);

  const sessions = new Map<ThreadId, BobSessionContext>();
  const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const randomUUIDv4 = crypto.randomUUIDv4.pipe(
    Effect.mapError(
      (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "crypto/randomUUIDv4",
          detail: "Failed to generate Bob runtime identifier.",
          cause,
        }),
    ),
  );
  const makeEventStamp = () =>
    Effect.all({
      eventId: Effect.map(randomUUIDv4, (id) => EventId.make(id)),
      createdAt: nowIso,
    });
  const offerRuntimeEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
    Queue.offer(runtimeEventQueue, event).pipe(Effect.asVoid);
  const cleanupStaging = Effect.fn("bob.cleanupStaging")(function* (turnState: BobTurnState) {
    if (!turnState.stagingDirectory) return;
    const directory = turnState.stagingDirectory;
    turnState.stagingDirectory = undefined;
    yield* fileSystem.remove(directory, { recursive: true }).pipe(Effect.ignore);
  });

  const cleanupStaleStaging = Effect.fn("bob.cleanupStaleStaging")(function* (workspace: string) {
    const root = path.join(workspace, ".t3-bob-attachments");
    const active = new Set(
      [...sessions.values()].flatMap((context) =>
        context.turnState?.stagingDirectory ? [context.turnState.stagingDirectory] : [],
      ),
    );
    const entries = yield* fileSystem
      .readDirectory(root)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    yield* Effect.forEach(
      entries.slice(0, 256),
      (entry) => {
        const candidate = path.join(root, entry);
        return active.has(candidate)
          ? Effect.void
          : fileSystem.remove(candidate, { recursive: true }).pipe(Effect.ignore);
      },
      { discard: true },
    );
  });

  const stageAttachments = Effect.fn("bob.stageAttachments")(function* (
    context: BobSessionContext,
    turnState: BobTurnState,
    attachments: ReadonlyArray<ChatAttachment>,
  ) {
    if (attachments.length === 0) return [] as Array<string>;
    if (!options?.attachmentsDir) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "sendTurn",
        issue: "Attachment storage is unavailable.",
      });
    }
    const workspace = context.session.cwd ?? process.cwd();
    const directory = path.join(workspace, ".t3-bob-attachments", String(turnState.turnId));
    yield* fileSystem.makeDirectory(directory, { recursive: true });
    turnState.stagingDirectory = directory;
    const references: Array<string> = [];
    for (const [index, attachment] of attachments.entries()) {
      const source = resolveAttachmentPath({ attachmentsDir: options.attachmentsDir, attachment });
      if (!source) {
        yield* cleanupStaging(turnState);
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: `Invalid attachment id '${attachment.id}'.`,
        });
      }
      const safeName =
        attachment.name.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^[-.]+/, "") || "image";
      const stagedName = `${safeName}${attachmentExtension(attachment)}`;
      const destination = path.join(directory, `${index + 1}-${stagedName}`);
      const bytes = yield* fileSystem.readFile(source);
      yield* fileSystem.writeFile(destination, bytes);
      references.push(path.relative(workspace, destination).split(path.sep).join("/"));
    }
    return references;
  });

  const requireSession = (
    threadId: ThreadId,
  ): Effect.Effect<BobSessionContext, ProviderAdapterError> => {
    const context = sessions.get(threadId);
    if (!context) {
      return Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
    }
    if (context.stopped || context.session.status === "closed") {
      return Effect.fail(new ProviderAdapterSessionClosedError({ provider: PROVIDER, threadId }));
    }
    return Effect.succeed(context);
  };

  const updateResumeCursor = (context: BobSessionContext): void => {
    // Bob resume state is adapter-owned: the shared service only persists the
    // cursor returned from `sendTurn`, not provider-specific runtime events.
    const { resumeCursor: _resumeCursor, ...sessionWithoutCursor } = context.session;
    context.session = {
      ...sessionWithoutCursor,
      ...(context.resumeTaskId
        ? {
            resumeCursor: {
              version: 1,
              taskId: context.resumeTaskId,
              cumulativeUsage: context.cumulativeUsage,
            },
          }
        : {}),
    };
  };

  const emitStreamDelta = Effect.fn("bob.emitStreamDelta")(function* (
    context: BobSessionContext,
    turnState: BobTurnState,
    itemId: string,
    streamKind: "assistant_text" | "reasoning_text",
    delta: string,
  ) {
    if (delta.length === 0) return;
    const stamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      type: "content.delta",
      eventId: stamp.eventId,
      provider: PROVIDER,
      providerInstanceId: boundInstanceId,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      turnId: turnState.turnId,
      itemId: RuntimeItemId.make(itemId),
      payload: { streamKind, delta },
    });
  });

  // Bob marks reasoning deltas explicitly; answer deltas use the assistant stream.
  const emitReasoningDelta = Effect.fn("bob.emitReasoningDelta")(function* (
    context: BobSessionContext,
    turnState: BobTurnState,
    delta: string,
  ) {
    if (delta.length === 0) return;
    if (turnState.reasoningItemId === undefined) {
      turnState.reasoningItemId = yield* randomUUIDv4;
    }
    turnState.reasoningText += delta;
    turnState.emittedReasoningDelta = true;
    yield* emitStreamDelta(context, turnState, turnState.reasoningItemId, "reasoning_text", delta);
  });

  const emitAssistantAnswer = Effect.fn("bob.emitAssistantAnswer")(function* (
    context: BobSessionContext,
    turnState: BobTurnState,
    answer: string,
  ) {
    if (answer.length === 0) return;
    turnState.emittedAssistantDelta = true;
    yield* emitStreamDelta(context, turnState, turnState.assistantItemId, "assistant_text", answer);
  });

  const completeFinalItems = Effect.fn("bob.completeFinalItems")(function* (
    context: BobSessionContext,
    turnState: BobTurnState,
  ) {
    if (turnState.reasoningItemId !== undefined && !turnState.reasoningCompleted) {
      turnState.reasoningCompleted = true;
      const detail = trimmedOrUndefined(turnState.reasoningText);
      const stamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "item.completed",
        eventId: stamp.eventId,
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        createdAt: stamp.createdAt,
        threadId: context.session.threadId,
        turnId: turnState.turnId,
        itemId: RuntimeItemId.make(turnState.reasoningItemId),
        payload: {
          itemType: "reasoning",
          status: "completed",
          title: "Reasoning",
          ...(detail ? { detail } : {}),
        },
      });
    }

    if (turnState.assistantCompleted) return;
    const answer = (turnState.finalAnswer ?? "").trim();
    if (answer.length === 0 && !turnState.emittedAssistantDelta) {
      return;
    }
    turnState.assistantCompleted = true;
    if (!turnState.emittedAssistantDelta && answer.length > 0) {
      yield* emitAssistantAnswer(context, turnState, answer);
    }
    const stamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      type: "item.completed",
      eventId: stamp.eventId,
      provider: PROVIDER,
      providerInstanceId: boundInstanceId,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      turnId: turnState.turnId,
      itemId: RuntimeItemId.make(turnState.assistantItemId),
      payload: {
        itemType: "assistant_message",
        status: "completed",
        title: "Assistant message",
        ...(answer.length > 0 ? { detail: answer } : {}),
      },
    });
  });

  const failOutstandingTools = Effect.fn("bob.failOutstandingTools")(function* (
    context: BobSessionContext,
    turnState: BobTurnState,
    detail: string,
  ) {
    for (const tool of turnState.tools.values()) {
      const stamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "item.completed",
        eventId: stamp.eventId,
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        createdAt: stamp.createdAt,
        threadId: context.session.threadId,
        turnId: turnState.turnId,
        itemId: RuntimeItemId.make(tool.itemId),
        payload: {
          itemType: tool.itemType,
          status: "failed",
          title: titleForItemType(tool.itemType),
          detail,
          data: { toolName: tool.toolName, input: tool.parameters },
        },
      });
      if (tool.taskId) {
        const taskStamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "task.completed",
          eventId: taskStamp.eventId,
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          createdAt: taskStamp.createdAt,
          threadId: context.session.threadId,
          turnId: turnState.turnId,
          payload: { taskId: tool.taskId, status: "failed", summary: detail },
        });
      }
    }
    turnState.tools.clear();
  });

  const emitTerminalUsage = Effect.fn("bob.emitTerminalUsage")(function* (
    context: BobSessionContext,
    turnState: BobTurnState,
  ) {
    const result = turnState.terminalResult;
    if (!result) return;
    const privateUsage = result.taskId
      ? yield* Effect.sync(() => readBobTaskUsage(result.taskId!, bobEnvironment))
      : undefined;
    const previous = context.cumulativeUsage;
    const source: BobCumulativeUsage = {
      bobcoins: privateUsage?.bobcoins ?? result.usage.bobcoins,
      inputTokens: result.usage.inputTokens ?? privateUsage?.inputTokens,
      outputTokens: result.usage.outputTokens ?? privateUsage?.outputTokens,
      cacheReadTokens: result.usage.cacheReadTokens ?? privateUsage?.cacheReadTokens,
      cacheWriteTokens: result.usage.cacheWriteTokens ?? privateUsage?.cacheWriteTokens,
      contextTokens: result.usage.contextTokens ?? privateUsage?.contextTokens,
    };
    const cumulative = (key: keyof BobCumulativeUsage) => {
      const before = previous[key];
      const after = source[key];
      if (before === undefined) return after;
      if (after === undefined) return before;
      return Math.max(before, after);
    };
    const next: BobCumulativeUsage = {
      bobcoins: cumulative("bobcoins"),
      inputTokens: cumulative("inputTokens"),
      outputTokens: cumulative("outputTokens"),
      cacheReadTokens: cumulative("cacheReadTokens"),
      cacheWriteTokens: cumulative("cacheWriteTokens"),
      contextTokens: source.contextTokens ?? previous.contextTokens,
    };
    context.cumulativeUsage = next;
    if (next.bobcoins !== undefined) {
      const stamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "thread.billing-usage.updated",
        eventId: stamp.eventId,
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        createdAt: stamp.createdAt,
        threadId: context.session.threadId,
        turnId: turnState.turnId,
        payload: {
          usage: {
            unit: "bobcoin",
            cumulativeAmount: next.bobcoins,
            turnAmount: Math.max(0, next.bobcoins - (previous.bobcoins ?? 0)),
          },
        },
      });
    }
    if (next.contextTokens !== undefined) {
      const delta = (key: keyof BobCumulativeUsage) =>
        Math.max(0, (next[key] ?? 0) - (previous[key] ?? 0));
      const stamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "thread.token-usage.updated",
        eventId: stamp.eventId,
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        createdAt: stamp.createdAt,
        threadId: context.session.threadId,
        turnId: turnState.turnId,
        payload: {
          usage: {
            usedTokens: next.contextTokens,
            totalProcessedTokens: (next.inputTokens ?? 0) + (next.outputTokens ?? 0),
            inputTokens: next.inputTokens,
            outputTokens: next.outputTokens,
            cachedInputTokens: next.cacheReadTokens,
            cacheWriteInputTokens: next.cacheWriteTokens,
            lastUsedTokens: next.contextTokens,
            lastInputTokens: delta("inputTokens"),
            lastOutputTokens: delta("outputTokens"),
            lastCachedInputTokens: delta("cacheReadTokens"),
            lastCacheWriteInputTokens: delta("cacheWriteTokens"),
            durationMs: result.durationMs,
            toolUses: result.toolCalls,
          },
        },
      });
    }
  });

  const completeTurn = Effect.fn("bob.completeTurn")(function* (
    context: BobSessionContext,
    turnState: BobTurnState,
    result: { readonly state: RuntimeTurnState; readonly errorMessage?: string },
  ) {
    if (turnState.completed || context.turnState !== turnState) {
      return;
    }
    turnState.completed = true;
    yield* cleanupStaging(turnState);

    if (turnState.tools.size > 0) {
      yield* failOutstandingTools(
        context,
        turnState,
        result.state === "interrupted"
          ? "Tool call interrupted before Bob returned a result."
          : "Bob ended the turn before returning a tool result.",
      );
    }
    yield* completeFinalItems(context, turnState);
    yield* emitTerminalUsage(context, turnState);

    context.turns.push({ id: turnState.turnId, items: [...turnState.items] });
    context.turnState = undefined;
    context.processFiber = undefined;
    context.child = undefined;
    updateResumeCursor(context);
    context.session = {
      ...context.session,
      status: "ready",
      activeTurnId: undefined,
      updatedAt: yield* nowIso,
    };

    const stamp = yield* makeEventStamp();
    const errorMessage = trimmedOrUndefined(result.errorMessage);
    yield* offerRuntimeEvent({
      type: "turn.completed",
      eventId: stamp.eventId,
      provider: PROVIDER,
      providerInstanceId: boundInstanceId,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      turnId: turnState.turnId,
      payload: {
        state: result.state,
        ...(errorMessage ? { errorMessage } : {}),
      },
    });
  });

  const handleToolUse = Effect.fn("bob.handleToolUse")(function* (
    context: BobSessionContext,
    turnState: BobTurnState,
    toolUse: Bob2ToolUseEvent,
  ) {
    const itemType = classifyToolItemType(toolUse.toolName);
    const itemId = toolUse.canonicalId;
    const taskId =
      itemType === "collab_agent_tool_call"
        ? RuntimeTaskId.make(`bob-${toolUse.canonicalId}`)
        : undefined;
    turnState.tools.set(toolUse.toolId, {
      itemId,
      itemType,
      toolName: toolUse.toolName,
      parameters: toolUse.parameters,
      ...(taskId ? { taskId } : {}),
    });

    const command =
      itemType === "command_execution" ? readBobToolCommand(toolUse.parameters) : undefined;
    const stamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      type: "item.started",
      eventId: stamp.eventId,
      provider: PROVIDER,
      providerInstanceId: boundInstanceId,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      turnId: turnState.turnId,
      itemId: RuntimeItemId.make(itemId),
      payload: {
        itemType,
        status: "inProgress",
        title: titleForItemType(itemType),
        detail: summarizeToolRequest(toolUse.toolName, toolUse.parameters),
        data: {
          toolName: toolUse.toolName,
          input: toolUse.parameters,
          ...(command ? { command } : {}),
        },
      },
    });
    if (taskId) {
      const taskStamp = yield* makeEventStamp();
      const description = readRecordString(toolUse.parameters, "description", "prompt", "task");
      const title = readRecordString(toolUse.parameters, "name", "agent", "subagent");
      yield* offerRuntimeEvent({
        type: "task.started",
        eventId: taskStamp.eventId,
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        createdAt: taskStamp.createdAt,
        threadId: context.session.threadId,
        turnId: turnState.turnId,
        payload: { taskId, ...(description ? { description } : {}), ...(title ? { title } : {}) },
      });
    }
  });

  const handleToolResult = Effect.fn("bob.handleToolResult")(function* (
    context: BobSessionContext,
    turnState: BobTurnState,
    toolResult: Bob2ToolResultEvent,
  ) {
    let tool = turnState.tools.get(toolResult.toolId);
    if (!tool) {
      tool = {
        itemId: toolResult.canonicalId,
        itemType: "dynamic_tool_call",
        toolName: "tool",
        parameters: undefined,
      };
      const startStamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "item.started",
        eventId: startStamp.eventId,
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        createdAt: startStamp.createdAt,
        threadId: context.session.threadId,
        turnId: turnState.turnId,
        itemId: RuntimeItemId.make(tool.itemId),
        payload: {
          itemType: tool.itemType,
          status: "inProgress",
          title: "Tool call",
          detail: "Bob tool result",
          data: { toolName: tool.toolName },
        },
      });
    }
    turnState.tools.delete(toolResult.toolId);

    // The web work-log renders `item.completed`, not `item.started`, so keep the
    // request summary on completion. Tool output is preserved in structured data
    // for expansion without replacing the command/input preview.
    const detail = summarizeToolRequest(tool.toolName, tool.parameters);
    const command =
      tool.itemType === "command_execution" ? readBobToolCommand(tool.parameters) : undefined;
    const stamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      type: "item.completed",
      eventId: stamp.eventId,
      provider: PROVIDER,
      providerInstanceId: boundInstanceId,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      turnId: turnState.turnId,
      itemId: RuntimeItemId.make(tool.itemId),
      payload: {
        itemType: tool.itemType,
        status:
          toolResult.status === "success" || toolResult.status === undefined
            ? "completed"
            : "failed",
        title: titleForItemType(tool.itemType),
        ...(detail ? { detail } : {}),
        data: {
          toolName: tool.toolName,
          input: tool.parameters,
          ...(command ? { command } : {}),
          ...(toolResult.output ? { result: toolResult.output } : {}),
        },
      },
    });
    const providerMode = switchedBobMode(tool);
    if (providerMode && (toolResult.status === "success" || toolResult.status === undefined)) {
      const modeStamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "thread.metadata.updated",
        eventId: modeStamp.eventId,
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        createdAt: modeStamp.createdAt,
        threadId: context.session.threadId,
        turnId: turnState.turnId,
        payload: { metadata: { providerMode } },
      });
    }
    if (tool.taskId) {
      const taskStamp = yield* makeEventStamp();
      const summary = stripTaskResultWrapper(toolResult.output);
      yield* offerRuntimeEvent({
        type: "task.completed",
        eventId: taskStamp.eventId,
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        createdAt: taskStamp.createdAt,
        threadId: context.session.threadId,
        turnId: turnState.turnId,
        payload: {
          taskId: tool.taskId,
          status:
            toolResult.status === "success" || toolResult.status === undefined
              ? "completed"
              : "failed",
          ...(summary ? { summary } : {}),
        },
      });
    }
  });

  const handleBobEvent = Effect.fn("bob.handleBobEvent")(function* (
    context: BobSessionContext,
    turnState: BobTurnState,
    event: Bob2DecodedEvent,
  ) {
    turnState.sawProtocolEvent = true;
    switch (event.type) {
      case "message": {
        if (event.role !== "assistant") return;
        if (event.isReasoning) {
          yield* emitReasoningDelta(context, turnState, event.content);
        } else {
          turnState.finalAnswer = `${turnState.finalAnswer ?? ""}${event.content}`;
          yield* emitAssistantAnswer(context, turnState, event.content);
        }
        return;
      }
      case "tool_use": {
        yield* handleToolUse(context, turnState, event);
        return;
      }
      case "tool_result": {
        yield* handleToolResult(context, turnState, event);
        return;
      }
      case "error": {
        turnState.observedError ??= `Bob: ${event.message}`;
        return;
      }
      case "result": {
        turnState.terminalResult = event;
        if (event.taskId) {
          context.resumeTaskId = event.taskId;
          updateResumeCursor(context);
        }
        const suffix = reconcileBob2LastMessage(turnState.finalAnswer ?? "", event.lastMessage);
        if (suffix) {
          turnState.finalAnswer = `${turnState.finalAnswer ?? ""}${suffix}`;
          yield* emitAssistantAnswer(context, turnState, suffix);
        }
        turnState.result = {
          state: turnStateFromBobStatus(event.status),
          ...(event.errorMessage ? { errorMessage: `Bob: ${event.errorMessage}` } : {}),
        };
        return;
      }
      case "malformed": {
        yield* Effect.logDebug("bob.stream.malformed-line", {
          reason: event.reason,
          sample: event.sample,
        });
        return;
      }
      default:
        return;
    }
  });

  const runBobTurn = (
    context: BobSessionContext,
    turnState: BobTurnState,
    opts: { readonly prompt: string; readonly mode: string },
  ) =>
    Effect.gen(function* () {
      const workspace = context.session.cwd ?? process.cwd();
      const args = buildBobTurnArgs({
        prompt: opts.prompt,
        workspace,
        mode: opts.mode,
        runtimeMode: context.session.runtimeMode,
        toolAccessCeiling: bobConfig.toolAccessCeiling,
        ...(context.resumeTaskId ? { resumeTaskId: context.resumeTaskId } : {}),
        ...(bobConfig.teamId ? { teamId: bobConfig.teamId } : {}),
        ...(bobConfig.taskCostThresholdBobcoins !== undefined
          ? { taskCostThresholdBobcoins: bobConfig.taskCostThresholdBobcoins }
          : {}),
        ...(bobConfig.maxTurns !== undefined ? { maxTurns: bobConfig.maxTurns } : {}),
      });
      const spawnCommand = yield* resolveSpawnCommand(binary, args, { env: bobEnvironment });
      const command = ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: bobEnvironment,
        cwd: workspace,
        // Bob 2 waits for EOF on stdin even when the prompt is supplied as an
        // argument. An empty stream closes the pipe immediately after spawn.
        stdin: Stream.empty,
        shell: spawnCommand.shell,
        forceKillAfter: "2 seconds",
      });
      const child = yield* spawner.spawn(command);
      context.child = child;

      let stderrTail = "";
      const stderrFiber = yield* child.stderr.pipe(
        Stream.decodeText(),
        Stream.runForEach((chunk) =>
          Effect.sync(() => {
            stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_LIMIT);
          }),
        ),
        Effect.forkScoped,
      );

      const decoder = new Bob2StreamDecoder();
      yield* child.stdout.pipe(
        Stream.decodeText(),
        Stream.runForEach((chunk) =>
          Effect.gen(function* () {
            for (const event of decoder.push(chunk)) {
              yield* handleBobEvent(context, turnState, event);
            }
          }),
        ),
      );
      for (const event of decoder.finish()) {
        yield* handleBobEvent(context, turnState, event);
      }

      const exitCode = yield* child.exitCode;
      yield* Fiber.join(stderrFiber);
      if (!turnState.completed) {
        const failureDetail = boundedStderrTail(stderrTail);
        const observedResult = turnState.result;
        const startupFailure =
          !turnState.sawProtocolEvent && failureDetail
            ? classifyBob2StartupFailure(failureDetail)
            : undefined;
        yield* completeTurn(
          context,
          turnState,
          turnState.interrupted
            ? { state: "interrupted" }
            : turnState.observedError
              ? { state: "failed", errorMessage: turnState.observedError }
              : exitCode === 0 &&
                  observedResult?.state === "completed" &&
                  turnState.terminalResult?.taskId
                ? observedResult
                : {
                    state: "failed",
                    errorMessage:
                      observedResult?.errorMessage ??
                      (startupFailure
                        ? `Bob ${startupFailure.kind}: ${startupFailure.message}`
                        : failureDetail
                          ? `Bob exited with code ${exitCode}: ${failureDetail}`
                          : exitCode === 0
                            ? "Bob exited without a valid terminal result."
                            : `Bob exited with code ${exitCode}.`),
                  },
        );
        if (exitCode === 0 && failureDetail) {
          yield* Effect.logWarning("bob.turn.stderr", {
            threadId: context.session.threadId,
            detail: failureDetail,
          });
        }
      }
    }).pipe(Effect.scoped);

  const stopSessionInternal = Effect.fn("bob.stopSessionInternal")(function* (
    context: BobSessionContext,
    options?: { readonly emitExitEvent?: boolean },
  ) {
    if (context.stopped) return;
    context.stopped = true;

    const turnState = context.turnState;
    if (turnState) {
      turnState.interrupted = true;
    }
    if (context.child) {
      yield* context.child
        .kill({ killSignal: "SIGINT", forceKillAfter: "2 seconds" })
        .pipe(Effect.ignore);
    } else if (context.processFiber) {
      yield* Fiber.interrupt(context.processFiber).pipe(Effect.ignore);
      if (turnState) {
        yield* completeTurn(context, turnState, { state: "interrupted" });
      }
    }

    context.session = {
      ...context.session,
      status: "closed",
      activeTurnId: undefined,
      updatedAt: yield* nowIso,
    };

    if (options?.emitExitEvent !== false) {
      const stamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "session.exited",
        eventId: stamp.eventId,
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        createdAt: stamp.createdAt,
        threadId: context.session.threadId,
        payload: { reason: "Session stopped", exitKind: "graceful" },
      });
    }

    sessions.delete(context.session.threadId);
  });

  const startSession: BobAdapterShape["startSession"] = Effect.fn("bob.startSession")(
    function* (input) {
      if (input.provider !== undefined && input.provider !== PROVIDER) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
        });
      }

      const existing = sessions.get(input.threadId);
      if (existing) {
        yield* stopSessionInternal(existing).pipe(Effect.ignore);
      }

      yield* cleanupStaleStaging(input.cwd ?? process.cwd());

      const startedAt = yield* nowIso;
      const resumeCursor = input.resumeCursor;
      const resumeRecord =
        resumeCursor && typeof resumeCursor === "object" && !Array.isArray(resumeCursor)
          ? (resumeCursor as Record<string, unknown>)
          : undefined;
      const candidateTaskId = resumeRecord ? readString(resumeRecord.taskId) : undefined;
      const validResumeCursor =
        resumeCursor === undefined ||
        (resumeRecord?.version === 1 &&
          candidateTaskId !== undefined &&
          isBob2TaskId(candidateTaskId));
      const resumeTaskId = validResumeCursor ? candidateTaskId : undefined;
      const cumulativeUsage =
        validResumeCursor && resumeRecord ? readCumulativeUsage(resumeRecord.cumulativeUsage) : {};

      const session: ProviderSession = {
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        status: "ready",
        runtimeMode: input.runtimeMode,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        threadId: input.threadId,
        ...(resumeTaskId
          ? { resumeCursor: { version: 1, taskId: resumeTaskId, cumulativeUsage } }
          : {}),
        createdAt: startedAt,
        updatedAt: startedAt,
      };

      const context: BobSessionContext = {
        session,
        resumeTaskId,
        continuationError: validResumeCursor
          ? undefined
          : "Bob continuation state is invalid. Start a new Bob context before sending another message.",
        turnState: undefined,
        processFiber: undefined,
        child: undefined,
        cumulativeUsage,
        turns: [],
        stopped: false,
      };
      sessions.set(input.threadId, context);

      const stamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "session.started",
        eventId: stamp.eventId,
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        createdAt: stamp.createdAt,
        threadId: input.threadId,
        payload: {},
      });

      return { ...session };
    },
  );

  const sendTurn: BobAdapterShape["sendTurn"] = Effect.fn("bob.sendTurn")(function* (input) {
    const context = yield* requireSession(input.threadId);
    if (context.turnState) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "turn/start",
        detail: "Bob does not support sending a turn while another turn is running.",
      });
    }
    if (context.continuationError) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "turn/start",
        detail: context.continuationError,
      });
    }

    const literalPrompt = input.input?.trim() ?? "";
    const attachments = input.attachments ?? [];
    if (literalPrompt.length === 0 && attachments.length === 0) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "turn/start",
        detail: "Bob requires non-empty text or an image attachment.",
      });
    }

    const modelSelection =
      input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
    const mode = resolveBobChatMode(input.interactionMode, input.providerMode);

    const turnId = TurnId.make(yield* randomUUIDv4);
    const turnState: BobTurnState = {
      turnId,
      assistantItemId: yield* randomUUIDv4,
      reasoningItemId: undefined,
      reasoningText: "",
      emittedReasoningDelta: false,
      reasoningCompleted: false,
      finalAnswer: undefined,
      emittedAssistantDelta: false,
      assistantCompleted: false,
      completed: false,
      interrupted: false,
      observedError: undefined,
      sawProtocolEvent: false,
      result: undefined,
      terminalResult: undefined,
      stagingDirectory: undefined,
      tools: new Map(),
      items: [],
    };
    context.turnState = turnState;
    const references = yield* stageAttachments(context, turnState, attachments).pipe(
      Effect.mapError((cause) =>
        cause._tag === "ProviderAdapterValidationError"
          ? cause
          : new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "turn/start",
              detail: "Failed to stage Bob image attachments.",
              cause,
            }),
      ),
      Effect.onError(() =>
        cleanupStaging(turnState).pipe(
          Effect.andThen(
            Effect.sync(() => {
              context.turnState = undefined;
            }),
          ),
        ),
      ),
    );
    const prompt = [literalPrompt, ...references.map((reference) => `@${reference}`)]
      .filter((part) => part.length > 0)
      .join("\n\n");
    context.session = {
      ...context.session,
      status: "running",
      ...(modelSelection?.model ? { model: modelSelection.model } : {}),
      activeTurnId: turnId,
      updatedAt: yield* nowIso,
    };

    const startStamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      type: "turn.started",
      eventId: startStamp.eventId,
      provider: PROVIDER,
      providerInstanceId: boundInstanceId,
      createdAt: startStamp.createdAt,
      threadId: context.session.threadId,
      turnId,
      payload: { model: "premium" },
    });

    const pump = runBobTurn(context, turnState, { prompt, mode }).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.void;
        }
        const squashed = Cause.squash(cause);
        return completeTurn(context, turnState, {
          state: "failed",
          errorMessage: squashed instanceof Error ? squashed.message : "Bob process failed.",
        }).pipe(Effect.ignore);
      }),
    );
    const fiber = yield* pump.pipe(Effect.forkIn(adapterScope));
    context.processFiber = fiber;

    return {
      threadId: context.session.threadId,
      turnId,
      ...(context.session.resumeCursor !== undefined
        ? { resumeCursor: context.session.resumeCursor }
        : {}),
    };
  });

  const interruptTurn: BobAdapterShape["interruptTurn"] = Effect.fn("bob.interruptTurn")(
    function* (threadId, _turnId) {
      const context = yield* requireSession(threadId);
      const turnState = context.turnState;
      if (turnState) {
        turnState.interrupted = true;
      }
      if (context.child) {
        yield* context.child
          .kill({ killSignal: "SIGINT", forceKillAfter: "2 seconds" })
          .pipe(Effect.ignore);
      } else if (context.processFiber) {
        yield* Fiber.interrupt(context.processFiber).pipe(Effect.ignore);
        if (turnState) {
          yield* completeTurn(context, turnState, { state: "interrupted" });
        }
      }
    },
  );

  const respondToRequest: BobAdapterShape["respondToRequest"] = Effect.fn("bob.respondToRequest")(
    function* (threadId, requestId, _decision) {
      yield* requireSession(threadId);
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "item/requestApproval/decision",
        detail: `Bob has no interactive approvals; actions are blocked by runtime mode and the instance tool ceiling (request ${requestId}).`,
      });
    },
  );

  const respondToUserInput: BobAdapterShape["respondToUserInput"] = Effect.fn(
    "bob.respondToUserInput",
  )(function* (threadId, requestId, _answers) {
    yield* requireSession(threadId);
    return yield* new ProviderAdapterRequestError({
      provider: PROVIDER,
      method: "item/tool/respondToUserInput",
      detail: `Bob does not request structured user input in non-interactive mode (request ${requestId}).`,
    });
  });

  const snapshotThread = (context: BobSessionContext) => ({
    threadId: context.session.threadId,
    turns: context.turns.map((turn) => ({ id: turn.id, items: [...turn.items] })),
  });

  const readThread: BobAdapterShape["readThread"] = Effect.fn("bob.readThread")(
    function* (threadId) {
      const context = yield* requireSession(threadId);
      return snapshotThread(context);
    },
  );

  const rollbackThread: BobAdapterShape["rollbackThread"] = Effect.fn("bob.rollbackThread")(
    function* (threadId, numTurns) {
      yield* requireSession(threadId);
      // Rollback would need Bob to fork or rewrite its own resumed session. Keep
      // that unsupported behavior inside the adapter boundary.
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "thread/rollback",
        detail: `Bob cannot roll back ${numTurns} turn(s) without retaining them in its resumed session.`,
      });
    },
  );

  const stopSession: BobAdapterShape["stopSession"] = Effect.fn("bob.stopSession")(
    function* (threadId) {
      const context = yield* requireSession(threadId);
      yield* stopSessionInternal(context, { emitExitEvent: true });
    },
  );

  const listSessions: BobAdapterShape["listSessions"] = () =>
    Effect.sync(() => Array.from(sessions.values(), ({ session }) => ({ ...session })));

  const hasSession: BobAdapterShape["hasSession"] = (threadId) =>
    Effect.sync(() => {
      const context = sessions.get(threadId);
      return context !== undefined && !context.stopped;
    });

  const stopAll: BobAdapterShape["stopAll"] = () =>
    Effect.forEach(
      sessions,
      ([, context]) => stopSessionInternal(context, { emitExitEvent: true }),
      {
        discard: true,
      },
    );

  yield* Effect.addFinalizer(() =>
    Effect.forEach(
      sessions,
      ([, context]) => stopSessionInternal(context, { emitExitEvent: false }),
      { discard: true },
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("Failed to tear down Bob sessions.", { cause: Cause.pretty(cause) }),
      ),
      Effect.tap(() => Queue.shutdown(runtimeEventQueue)),
    ),
  );

  return {
    provider: PROVIDER,
    capabilities: BOB_ADAPTER_CAPABILITIES,
    getProjectMetadata: (cwd) =>
      discoverBobModes(cwd, bobEnvironment).pipe(
        Effect.map((modes) => ({ workspaceTrusted: true, modes, slashCommands: [], skills: [] })),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      ),
    resetContext: (threadId) =>
      requireSession(threadId).pipe(
        Effect.flatMap((context) => {
          if (context.turnState) {
            return Effect.fail(
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "thread/resetContext",
                detail: "Cannot reset Bob context while a turn is running.",
              }),
            );
          }
          return Effect.gen(function* () {
            context.resumeTaskId = undefined;
            context.continuationError = undefined;
            context.cumulativeUsage = {};
            updateResumeCursor(context);
            const stamp = yield* makeEventStamp();
            yield* offerRuntimeEvent({
              ...stamp,
              provider: PROVIDER,
              threadId,
              type: "session.configured",
              payload: { config: { continuation: "reset" } },
            });
            return { ...context.session };
          });
        }),
      ),
    startSession,
    sendTurn,
    interruptTurn,
    readThread,
    rollbackThread,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    stopAll,
    get streamEvents() {
      return Stream.fromQueue(runtimeEventQueue);
    },
  } satisfies BobAdapterShape;
});
