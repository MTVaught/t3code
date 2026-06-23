/**
 * BobAdapter — provider adapter for the IBM Bob CLI (`bob`).
 *
 * Unlike the long-lived process adapters (Codex app-server, Cursor/Grok ACP),
 * `bob` has no persistent stdio protocol. Each turn is a fresh one-shot
 * subprocess:
 *
 *   bob -p "<prompt>" -o stream-json -m <tier> --chat-mode <mode> [--yolo] [-r <id>]
 *
 * The subprocess streams newline-delimited JSON events to stdout, which this
 * adapter parses and maps into canonical {@link ProviderRuntimeEvent}s. Cross-
 * turn continuity is achieved by capturing the `session_id` from bob's `init`
 * event and replaying it with `-r` on the next turn.
 *
 * Constraints (documented for the MVP):
 *   - No interactive approvals: bob runs under a fixed approval mode
 *     (`approvalMode` setting). `respondToRequest`/`respondToUserInput` are
 *     inert — the adapter never opens approval/user-input requests.
 *   - One turn at a time: a one-shot process cannot be steered, so a second
 *     `sendTurn` while a turn is running is rejected.
 *   - `rollbackThread` rolls back only the adapter's in-memory view.
 *
 * @module provider/Layers/BobAdapter
 */
import {
  type BobSettings,
  type CanonicalItemType,
  EventId,
  type ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type RuntimeTurnState,
  RuntimeItemId,
  ThreadId,
  type ThreadTokenUsageSnapshot,
  TurnId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
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
import { BOB_BUILT_IN_MODEL_SLUGS } from "./BobProvider.ts";
import { type BobAdapterShape } from "../Services/BobAdapter.ts";

const PROVIDER = ProviderDriverKind.make("bob");
const STDERR_TAIL_LIMIT = 4_000;

interface BobToolInFlight {
  readonly itemId: string;
  readonly itemType: CanonicalItemType;
  readonly toolName: string;
  /** The tool's request parameters, retained so the completed event can carry
   * the input even when bob's `tool_result.output` is empty. */
  readonly parameters: unknown;
}

interface BobTurnState {
  readonly turnId: TurnId;
  /** Item id for the final assistant answer (from `attempt_completion`). */
  readonly assistantItemId: string;
  /** Lazily-created item id for the model's intermediary reasoning stream. */
  reasoningItemId: string | undefined;
  reasoningText: string;
  emittedReasoningDelta: boolean;
  reasoningCompleted: boolean;
  /** The authoritative final answer captured from `attempt_completion`. */
  finalAnswer: string | undefined;
  emittedAssistantDelta: boolean;
  assistantCompleted: boolean;
  completed: boolean;
  totalCostUsd: number | undefined;
  /** bob's context window for this turn's tier, used as the token-usage max. */
  readonly contextWindowTokens: number;
  readonly tools: Map<string, BobToolInFlight>;
  readonly items: Array<unknown>;
}

interface BobSessionContext {
  session: ProviderSession;
  resumeSessionId: string | undefined;
  turnState: BobTurnState | undefined;
  processFiber: Fiber.Fiber<void> | undefined;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  stopped: boolean;
}

export interface BobAdapterLiveOptions {
  readonly instanceId?: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function trimmedOrUndefined(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function finiteNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

/** Extract the human-readable error from a bob `result` event, if present. */
function readBobResultError(event: Record<string, unknown>): string | undefined {
  const error = event.error;
  if (error && typeof error === "object" && !Array.isArray(error)) {
    return readString((error as Record<string, unknown>).message);
  }
  return readString(event.error);
}

function parseJsonRecord(line: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
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
  if (normalized.includes("browser") || normalized.includes("web") || normalized.includes("search")) {
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

function summarizeToolRequest(toolName: string, parameters: unknown): string {
  if (parameters && typeof parameters === "object" && !Array.isArray(parameters)) {
    const record = parameters as Record<string, unknown>;
    // bob tools use a variety of parameter keys (e.g. `file_path`, `dir_path`).
    // Surface the most informative one so the work-log row reads cleanly instead
    // of dumping raw JSON.
    const highlight =
      readString(record.command) ??
      readString(record.cmd) ??
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
 * bob's per-model context window, in input tokens. bob never reports the window
 * size in its stream-json output (its `result.stats` carries token counts but no
 * limit), yet it tracks one internally — its `tokenLimit()` maps each tier to a
 * fixed size. These values mirror that table so the context-window meter can show
 * a fill ratio. Unknown / custom tiers fall back to bob's own default.
 */
const BOB_DEFAULT_CONTEXT_WINDOW = 1_048_576;
const BOB_MODEL_CONTEXT_WINDOWS: ReadonlyMap<string, number> = new Map([
  ["premium", 1_048_576],
  ["premium2", 1_048_576],
  ["premium4", 1_048_576],
  ["bob-2.0-flash", 1_048_576],
  ["bob-1.5-flash", 1_048_576],
  ["bob-1.5-pro", 2_097_152],
  ["bob-2.0-flash-preview-image-generation", 32_000],
]);

function bobContextWindowForTier(tier: string): number {
  return BOB_MODEL_CONTEXT_WINDOWS.get(tier) ?? BOB_DEFAULT_CONTEXT_WINDOW;
}

/**
 * Resolve the bob model tier from the model selection, falling back to bob's
 * default ("premium") when unset or unknown.
 */
function resolveBobTier(
  modelSelection: ModelSelection | undefined,
  customModels: ReadonlyArray<string>,
): string {
  const slug = modelSelection?.model;
  if (slug && (BOB_BUILT_IN_MODEL_SLUGS.has(slug) || customModels.includes(slug))) {
    return slug;
  }
  return "premium";
}

function resolveBobChatMode(
  interactionMode: "default" | "plan" | undefined,
  config: BobSettings,
): string {
  return interactionMode === "plan" ? "plan" : config.chatMode;
}

function approvalArgs(approvalMode: BobSettings["approvalMode"]): ReadonlyArray<string> {
  switch (approvalMode) {
    case "yolo":
      return ["--yolo"];
    case "auto_edit":
      return ["--approval-mode", "auto_edit"];
    default:
      return [];
  }
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
    context.session = {
      ...context.session,
      ...(context.resumeSessionId
        ? { resumeCursor: { resumeSessionId: context.resumeSessionId } }
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

  // bob streams the model's intermediary output (its `<thinking>` reasoning and
  // tool narration) as assistant `message` events. The actual answer arrives
  // only via the `attempt_completion` tool. So intermediary text is mapped to a
  // reasoning stream, not the assistant message.
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
    // Prefer the attempt_completion answer; fall back to the intermediary text
    // only if bob never emitted a completion (rare).
    const answer = (turnState.finalAnswer ?? turnState.reasoningText).trim();
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

  const completeTurn = Effect.fn("bob.completeTurn")(function* (
    context: BobSessionContext,
    turnState: BobTurnState,
    result: { readonly state: RuntimeTurnState; readonly errorMessage?: string },
  ) {
    if (turnState.completed || context.turnState !== turnState) {
      return;
    }
    turnState.completed = true;

    yield* completeFinalItems(context, turnState);

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
        ...(turnState.totalCostUsd !== undefined ? { totalCostUsd: turnState.totalCostUsd } : {}),
      },
    });

    context.turns.push({ id: turnState.turnId, items: [...turnState.items] });
    context.turnState = undefined;
    context.processFiber = undefined;
    updateResumeCursor(context);
    context.session = {
      ...context.session,
      status: "ready",
      activeTurnId: undefined,
      updatedAt: yield* nowIso,
    };
  });

  const handleToolUse = Effect.fn("bob.handleToolUse")(function* (
    context: BobSessionContext,
    turnState: BobTurnState,
    event: Record<string, unknown>,
  ) {
    const toolName = readString(event.tool_name) ?? "tool";
    const toolId = readString(event.tool_id) ?? `${toolName}-${turnState.tools.size}`;

    // `attempt_completion` is bob's completion signal, not a real tool. Its
    // `parameters.result` carries the final answer — the only authoritative
    // assistant output. Stream it as the assistant message.
    if (toolName === "attempt_completion") {
      const params = event.parameters;
      const resultText =
        params && typeof params === "object" && !Array.isArray(params)
          ? readString((params as Record<string, unknown>).result)
          : undefined;
      if (resultText) {
        turnState.finalAnswer = resultText;
        yield* emitAssistantAnswer(context, turnState, resultText);
      }
      return;
    }

    const itemType = classifyToolItemType(toolName);
    const itemId = yield* randomUUIDv4;
    const parameters = event.parameters;
    turnState.tools.set(toolId, { itemId, itemType, toolName, parameters });

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
        detail: summarizeToolRequest(toolName, parameters),
        data: { toolName, input: parameters },
      },
    });
  });

  const handleToolResult = Effect.fn("bob.handleToolResult")(function* (
    context: BobSessionContext,
    turnState: BobTurnState,
    event: Record<string, unknown>,
  ) {
    const toolId = readString(event.tool_id);
    if (!toolId) return;
    const tool = turnState.tools.get(toolId);
    if (!tool) return;
    turnState.tools.delete(toolId);

    const status = readString(event.status);
    const output = trimmedOrUndefined(readString(event.output));
    // The web work-log renders `item.completed`, not `item.started`. bob's tool
    // output is frequently empty (e.g. `read_file`), so fall back to summarizing
    // the request input — otherwise the row would render as a bare "Tool call".
    const detail = output ? output.slice(0, 4000) : summarizeToolRequest(tool.toolName, tool.parameters);
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
        status: status === "success" || status === undefined ? "completed" : "failed",
        title: titleForItemType(tool.itemType),
        ...(detail ? { detail } : {}),
        data: {
          toolName: tool.toolName,
          input: tool.parameters,
          ...(output ? { result: output } : {}),
        },
      },
    });
  });

  const emitTokenUsage = Effect.fn("bob.emitTokenUsage")(function* (
    context: BobSessionContext,
    turnState: BobTurnState,
    stats: Record<string, unknown>,
  ) {
    const inputTokens = finiteNonNegativeInteger(stats.input_tokens);
    const outputTokens = finiteNonNegativeInteger(stats.output_tokens);
    const totalTokens = finiteNonNegativeInteger(stats.total_tokens);
    // The context-window meter wants the tokens currently occupying the window.
    // bob's `input_tokens` is exactly that — the prompt size sent to the model on
    // the most recent request — and it shrinks when bob auto-summarizes a long
    // session. Fall back to `total_tokens` if bob omits the breakdown.
    const usedTokens = inputTokens ?? totalTokens;
    if (usedTokens === undefined || usedTokens <= 0) {
      return;
    }
    const durationMs = finiteNonNegativeInteger(stats.duration_ms);
    const toolUses = finiteNonNegativeInteger(stats.tool_calls);
    const usage: ThreadTokenUsageSnapshot = {
      usedTokens,
      maxTokens: turnState.contextWindowTokens,
      // bob continuously summarizes long sessions, so the window can shrink
      // turn-over-turn rather than only growing.
      compactsAutomatically: true,
      ...(totalTokens !== undefined ? { totalProcessedTokens: totalTokens } : {}),
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(toolUses !== undefined ? { toolUses } : {}),
    };
    const stamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      type: "thread.token-usage.updated",
      eventId: stamp.eventId,
      provider: PROVIDER,
      providerInstanceId: boundInstanceId,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      turnId: turnState.turnId,
      payload: { usage },
    });
  });

  const handleBobLine = Effect.fn("bob.handleBobLine")(function* (
    context: BobSessionContext,
    turnState: BobTurnState,
    line: string,
  ) {
    const event = parseJsonRecord(line);
    if (!event) {
      yield* Effect.logDebug("bob.stream.unparseable-line", { line: line.slice(0, 200) });
      return;
    }
    const type = readString(event.type);
    switch (type) {
      case "init": {
        const sessionId = readString(event.session_id);
        if (sessionId && isUuid(sessionId)) {
          context.resumeSessionId = sessionId;
          updateResumeCursor(context);
        }
        return;
      }
      case "message": {
        if (readString(event.role) !== "assistant") {
          return; // ignore the echoed user message
        }
        const content = readString(event.content);
        if (!content) return;
        // Suppress bob's inline tool-status lines; tool lifecycle comes from
        // the dedicated tool_use/tool_result events.
        if (content.startsWith("[using tool ")) {
          return;
        }
        // Assistant `message` events are intermediary reasoning, not the answer.
        // Strip the <thinking> wrappers and stream the rest as reasoning.
        const cleaned = content.split("<thinking>").join("").split("</thinking>").join("");
        if (cleaned.length === 0) return;
        yield* emitReasoningDelta(context, turnState, cleaned);
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
      case "result": {
        const status = readString(event.status);
        const stats =
          event.stats && typeof event.stats === "object" && !Array.isArray(event.stats)
            ? (event.stats as Record<string, unknown>)
            : undefined;
        if (stats) {
          const cost = stats.session_costs;
          if (typeof cost === "number" && Number.isFinite(cost)) {
            turnState.totalCostUsd = cost;
          }
          yield* emitTokenUsage(context, turnState, stats);
        }
        const errorMessage = status === "success" ? undefined : readBobResultError(event);
        yield* completeTurn(context, turnState, {
          state: turnStateFromBobStatus(status),
          ...(errorMessage ? { errorMessage: `Bob: ${errorMessage}` } : {}),
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
    opts: { readonly prompt: string; readonly tier: string; readonly chatMode: string },
  ) =>
    Effect.gen(function* () {
      const args = [
        "-p",
        opts.prompt,
        "-o",
        "stream-json",
        "-m",
        opts.tier,
        "--chat-mode",
        opts.chatMode,
        ...approvalArgs(bobConfig.approvalMode),
        ...(bobConfig.maxCoins.trim().length > 0
          ? ["--max-coins", bobConfig.maxCoins.trim()]
          : []),
        ...(context.resumeSessionId ? ["-r", context.resumeSessionId] : []),
      ];
      const spawnCommand = yield* resolveSpawnCommand(binary, args, { env: bobEnvironment });
      const command = ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: bobEnvironment,
        ...(context.session.cwd ? { cwd: context.session.cwd } : {}),
        shell: spawnCommand.shell,
        forceKillAfter: "2 seconds",
      });
      const child = yield* spawner.spawn(command);

      let stderrTail = "";
      yield* child.stderr.pipe(
        Stream.decodeText(),
        Stream.runForEach((chunk) =>
          Effect.sync(() => {
            stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_LIMIT);
          }),
        ),
        Effect.forkScoped,
        Effect.asVoid,
      );

      let carry = "";
      yield* child.stdout.pipe(
        Stream.decodeText(),
        Stream.runForEach((chunk) =>
          Effect.gen(function* () {
            carry += chunk;
            let newlineIndex = carry.indexOf("\n");
            while (newlineIndex >= 0) {
              const line = carry.slice(0, newlineIndex).trim();
              carry = carry.slice(newlineIndex + 1);
              if (line.length > 0) {
                yield* handleBobLine(context, turnState, line);
              }
              newlineIndex = carry.indexOf("\n");
            }
          }),
        ),
      );
      const tail = carry.trim();
      if (tail.length > 0) {
        yield* handleBobLine(context, turnState, tail);
      }

      const exitCode = yield* child.exitCode;
      if (!turnState.completed) {
        const failureDetail = trimmedOrUndefined(stderrTail);
        yield* completeTurn(
          context,
          turnState,
          exitCode === 0
            ? { state: "completed" }
            : {
                state: "failed",
                errorMessage: failureDetail
                  ? `Bob exited with code ${exitCode}: ${failureDetail}`
                  : `Bob exited with code ${exitCode}.`,
              },
        );
      }
    }).pipe(Effect.scoped);

  const stopSessionInternal = Effect.fn("bob.stopSessionInternal")(function* (
    context: BobSessionContext,
    options?: { readonly emitExitEvent?: boolean },
  ) {
    if (context.stopped) return;
    context.stopped = true;

    const fiber = context.processFiber;
    const turnState = context.turnState;
    if (turnState) {
      yield* completeTurn(context, turnState, { state: "interrupted" });
    }
    if (fiber) {
      yield* Fiber.interrupt(fiber).pipe(Effect.ignore);
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

      const startedAt = yield* nowIso;
      const resumeCursor = input.resumeCursor;
      const resumeSessionId =
        resumeCursor && typeof resumeCursor === "object" && !Array.isArray(resumeCursor)
          ? readString((resumeCursor as Record<string, unknown>).resumeSessionId)
          : undefined;

      const session: ProviderSession = {
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        status: "ready",
        runtimeMode: input.runtimeMode,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        threadId: input.threadId,
        ...(resumeSessionId ? { resumeCursor: { resumeSessionId } } : {}),
        createdAt: startedAt,
        updatedAt: startedAt,
      };

      const context: BobSessionContext = {
        session,
        resumeSessionId,
        turnState: undefined,
        processFiber: undefined,
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

    const prompt = input.input?.trim() ?? "";
    if (prompt.length === 0) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "turn/start",
        detail: "Bob requires non-empty text input; attachments are not supported.",
      });
    }
    if ((input.attachments?.length ?? 0) > 0) {
      yield* Effect.logWarning("bob.turn.attachments-ignored", {
        threadId: input.threadId,
        count: input.attachments?.length ?? 0,
      });
    }

    const modelSelection =
      input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
    const tier = resolveBobTier(modelSelection, bobConfig.customModels);
    const chatMode = resolveBobChatMode(input.interactionMode, bobConfig);

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
      totalCostUsd: undefined,
      contextWindowTokens: bobContextWindowForTier(tier),
      tools: new Map(),
      items: [],
    };
    context.turnState = turnState;
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
      payload: { model: tier },
    });

    const pump = runBobTurn(context, turnState, { prompt, tier, chatMode }).pipe(
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
      const fiber = context.processFiber;
      const turnState = context.turnState;
      if (turnState) {
        yield* completeTurn(context, turnState, { state: "interrupted" });
      }
      if (fiber) {
        yield* Fiber.interrupt(fiber).pipe(Effect.ignore);
      }
    },
  );

  const respondToRequest: BobAdapterShape["respondToRequest"] = Effect.fn("bob.respondToRequest")(
    function* (threadId, requestId, _decision) {
      yield* requireSession(threadId);
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "item/requestApproval/decision",
        detail: `Bob has no interactive approvals; configure approvalMode instead (request ${requestId}).`,
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

  const readThread: BobAdapterShape["readThread"] = Effect.fn("bob.readThread")(function* (
    threadId,
  ) {
    const context = yield* requireSession(threadId);
    return snapshotThread(context);
  });

  const rollbackThread: BobAdapterShape["rollbackThread"] = Effect.fn("bob.rollbackThread")(
    function* (threadId, numTurns) {
      const context = yield* requireSession(threadId);
      const nextLength = Math.max(0, context.turns.length - numTurns);
      context.turns.splice(nextLength);
      return snapshotThread(context);
    },
  );

  const stopSession: BobAdapterShape["stopSession"] = Effect.fn("bob.stopSession")(function* (
    threadId,
  ) {
    const context = yield* requireSession(threadId);
    yield* stopSessionInternal(context, { emitExitEvent: true });
  });

  const listSessions: BobAdapterShape["listSessions"] = () =>
    Effect.sync(() => Array.from(sessions.values(), ({ session }) => ({ ...session })));

  const hasSession: BobAdapterShape["hasSession"] = (threadId) =>
    Effect.sync(() => {
      const context = sessions.get(threadId);
      return context !== undefined && !context.stopped;
    });

  const stopAll: BobAdapterShape["stopAll"] = () =>
    Effect.forEach(sessions, ([, context]) => stopSessionInternal(context, { emitExitEvent: true }), {
      discard: true,
    });

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
    capabilities: {
      sessionModelSwitch: "in-session",
    },
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
