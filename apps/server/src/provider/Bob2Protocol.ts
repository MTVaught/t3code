import * as NodeCrypto from "node:crypto";

export const BOB2_PROTOCOL_LIMITS = {
  lineCharacters: 256 * 1024,
  carryCharacters: 256 * 1024,
  stderrCharacters: 8 * 1024,
  malformedSampleCharacters: 512,
  messageCharacters: 128 * 1024,
  toolOutputCharacters: 128 * 1024,
  lastMessageCharacters: 128 * 1024,
  opaqueIdCharacters: 4 * 1024,
  errorsPerTurn: 64,
} as const;

const TASK_ID_PATTERN = /^[0-9a-f]{32}$/;

type Bob2Role = "assistant" | "user";

export interface Bob2MessageEvent {
  readonly type: "message";
  readonly role: Bob2Role;
  readonly content: string;
  readonly isReasoning: boolean;
}

export interface Bob2ToolUseEvent {
  readonly type: "tool_use";
  readonly toolName: string;
  readonly toolId: string;
  readonly canonicalId: string;
  readonly parameters: unknown;
}

export interface Bob2ToolResultEvent {
  readonly type: "tool_result";
  readonly toolId: string;
  readonly canonicalId: string;
  readonly status: string | undefined;
  readonly output: string | undefined;
}

export interface Bob2ErrorEvent {
  readonly type: "error";
  readonly severity: string;
  readonly message: string;
  readonly identity: string;
}

export interface Bob2PublicUsage {
  readonly bobcoins: number | undefined;
  readonly inputTokens: number | undefined;
  readonly outputTokens: number | undefined;
  readonly cacheReadTokens: number | undefined;
  readonly cacheWriteTokens: number | undefined;
  readonly contextTokens: number | undefined;
}

export interface Bob2ResultEvent {
  readonly type: "result";
  readonly status: string | undefined;
  readonly taskId: string | undefined;
  readonly durationMs: number | undefined;
  readonly toolCalls: number | undefined;
  readonly usage: Bob2PublicUsage;
  readonly lastMessage: string | undefined;
  readonly errorMessage: string | undefined;
}

export interface Bob2UnknownEvent {
  readonly type: "unknown";
  readonly eventType: string | undefined;
}

export interface Bob2MalformedLine {
  readonly type: "malformed";
  readonly reason: "invalid-json" | "invalid-event" | "line-too-long";
  readonly sample: string;
}

export type Bob2DecodedEvent =
  | Bob2MessageEvent
  | Bob2ToolUseEvent
  | Bob2ToolResultEvent
  | Bob2ErrorEvent
  | Bob2ResultEvent
  | Bob2UnknownEvent
  | Bob2MalformedLine;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function boundedString(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return value.slice(0, limit);
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function finiteNonNegativeInteger(value: unknown): number | undefined {
  const number = finiteNonNegative(value);
  return number === undefined ? undefined : Math.round(number);
}

function readNumber(recordValue: Record<string, unknown>, ...keys: ReadonlyArray<string>) {
  for (const key of keys) {
    const value = finiteNonNegative(recordValue[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function readInteger(recordValue: Record<string, unknown>, ...keys: ReadonlyArray<string>) {
  for (const key of keys) {
    const value = finiteNonNegativeInteger(recordValue[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

export function isBob2TaskId(value: string): boolean {
  return TASK_ID_PATTERN.test(value);
}

export function canonicalBobId(kind: "item" | "task", rawId: string): string {
  const digest = NodeCrypto.createHash("sha256")
    .update(kind)
    .update("\0")
    .update(rawId)
    .digest("hex");
  return `bob-${kind}-${digest.slice(0, 24)}`;
}

function malformed(reason: Bob2MalformedLine["reason"], sample: string): Bob2MalformedLine {
  return {
    type: "malformed",
    reason,
    sample: sample.slice(0, BOB2_PROTOCOL_LIMITS.malformedSampleCharacters),
  };
}

function decodeRecord(value: Record<string, unknown>): Bob2DecodedEvent {
  const eventType = boundedString(value.type, 64);
  switch (eventType) {
    case "message": {
      const role = value.role;
      const content = boundedString(value.content, BOB2_PROTOCOL_LIMITS.messageCharacters);
      if ((role !== "assistant" && role !== "user") || content === undefined) {
        return malformed("invalid-event", JSON.stringify(value));
      }
      return {
        type: "message",
        role,
        content,
        isReasoning: value.isReasoning === true,
      };
    }
    case "tool_use": {
      const toolName = boundedString(value.tool_name, 256);
      const toolId = boundedString(value.tool_id, BOB2_PROTOCOL_LIMITS.opaqueIdCharacters);
      if (toolName === undefined || toolId === undefined) {
        return malformed("invalid-event", JSON.stringify(value));
      }
      return {
        type: "tool_use",
        toolName,
        toolId,
        canonicalId: canonicalBobId("item", toolId),
        parameters: value.parameters,
      };
    }
    case "tool_result": {
      const toolId = boundedString(value.tool_id, BOB2_PROTOCOL_LIMITS.opaqueIdCharacters);
      if (toolId === undefined) return malformed("invalid-event", JSON.stringify(value));
      return {
        type: "tool_result",
        toolId,
        canonicalId: canonicalBobId("item", toolId),
        status: boundedString(value.status, 64),
        output: boundedString(value.output, BOB2_PROTOCOL_LIMITS.toolOutputCharacters),
      };
    }
    case "error": {
      const message = boundedString(value.message, BOB2_PROTOCOL_LIMITS.messageCharacters);
      if (message === undefined) return malformed("invalid-event", JSON.stringify(value));
      const severity = boundedString(value.severity, 32) ?? "error";
      return {
        type: "error",
        severity,
        message,
        identity: canonicalBobId("item", `${severity}\0${message}`),
      };
    }
    case "result": {
      const stats = record(value.stats) ?? {};
      const error = record(value.error);
      const taskIdValue = boundedString(stats.task_id, 128);
      const taskId = taskIdValue && isBob2TaskId(taskIdValue) ? taskIdValue : undefined;
      return {
        type: "result",
        status: boundedString(value.status, 64),
        taskId,
        durationMs: readInteger(stats, "duration_ms", "durationMs"),
        toolCalls: readInteger(stats, "tool_calls", "toolCalls"),
        usage: {
          bobcoins: readNumber(stats, "session_costs", "sessionCosts", "bobcoins"),
          inputTokens: readInteger(stats, "input_tokens", "inputTokens", "input"),
          outputTokens: readInteger(stats, "output_tokens", "outputTokens", "output"),
          cacheReadTokens: readInteger(stats, "cache_read_tokens", "cacheReadTokens", "cacheRead"),
          cacheWriteTokens: readInteger(
            stats,
            "cache_write_tokens",
            "cacheWriteTokens",
            "cacheWrite",
          ),
          contextTokens: readInteger(stats, "context_tokens", "contextTokens"),
        },
        lastMessage: boundedString(
          value.last_message ?? stats.last_message,
          BOB2_PROTOCOL_LIMITS.lastMessageCharacters,
        ),
        errorMessage: boundedString(
          error?.message ?? value.error,
          BOB2_PROTOCOL_LIMITS.messageCharacters,
        ),
      };
    }
    default:
      return { type: "unknown", eventType };
  }
}

export function decodeBob2Line(line: string): Bob2DecodedEvent {
  if (line.length > BOB2_PROTOCOL_LIMITS.lineCharacters) {
    return malformed("line-too-long", line);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return malformed("invalid-json", line);
  }
  const parsedRecord = record(parsed);
  return parsedRecord ? decodeRecord(parsedRecord) : malformed("invalid-event", line);
}

export class Bob2StreamDecoder {
  private carry = "";
  private discardingOversizedLine = false;
  private readonly errorIdentities = new Set<string>();

  push(chunk: string): ReadonlyArray<Bob2DecodedEvent> {
    const output: Array<Bob2DecodedEvent> = [];
    let remaining = chunk;
    while (remaining.length > 0) {
      const newlineIndex = remaining.indexOf("\n");
      const part = newlineIndex === -1 ? remaining : remaining.slice(0, newlineIndex);
      remaining = newlineIndex === -1 ? "" : remaining.slice(newlineIndex + 1);

      if (!this.discardingOversizedLine) {
        if (this.carry.length + part.length > BOB2_PROTOCOL_LIMITS.carryCharacters) {
          const sample = `${this.carry}${part}`;
          this.carry = "";
          this.discardingOversizedLine = true;
          output.push(malformed("line-too-long", sample));
        } else {
          this.carry += part;
        }
      }

      if (newlineIndex !== -1) {
        if (this.discardingOversizedLine) {
          this.discardingOversizedLine = false;
        } else if (this.carry.trim().length > 0) {
          this.appendDecoded(output, decodeBob2Line(this.carry));
          this.carry = "";
        } else {
          this.carry = "";
        }
      }
    }
    return output;
  }

  finish(): ReadonlyArray<Bob2DecodedEvent> {
    if (this.discardingOversizedLine) {
      this.discardingOversizedLine = false;
      this.carry = "";
      return [];
    }
    if (this.carry.trim().length === 0) {
      this.carry = "";
      return [];
    }
    const event = decodeBob2Line(this.carry);
    this.carry = "";
    const output: Array<Bob2DecodedEvent> = [];
    this.appendDecoded(output, event);
    return output;
  }

  private appendDecoded(output: Array<Bob2DecodedEvent>, event: Bob2DecodedEvent) {
    if (event.type !== "error") {
      output.push(event);
      return;
    }
    if (this.errorIdentities.has(event.identity)) return;
    if (this.errorIdentities.size < BOB2_PROTOCOL_LIMITS.errorsPerTurn) {
      this.errorIdentities.add(event.identity);
      output.push(event);
    }
  }
}

export type Bob2StartupFailureKind =
  | "missing-task"
  | "authentication"
  | "license"
  | "invalid-mode"
  | "invalid-arguments"
  | "unknown";

export interface Bob2StartupFailure {
  readonly kind: Bob2StartupFailureKind;
  readonly message: string;
}

export function boundedStderrTail(stderr: string): string {
  return stderr.slice(-BOB2_PROTOCOL_LIMITS.stderrCharacters).trim();
}

export function classifyBob2StartupFailure(stderr: string): Bob2StartupFailure {
  const message = boundedStderrTail(stderr) || "Bob exited before emitting a protocol event.";
  const normalized = message.toLowerCase();
  const kind = /no task found|task .*not found/.test(normalized)
    ? "missing-task"
    : /auth|api[_ -]?key|unauthorized|log in|login/.test(normalized)
      ? "authentication"
      : /licen[cs]e/.test(normalized)
        ? "license"
        : /invalid|unknown|not found/.test(normalized) && /mode/.test(normalized)
          ? "invalid-mode"
          : /invalid (argument|option)|unknown (argument|option)|usage:/.test(normalized)
            ? "invalid-arguments"
            : "unknown";
  return { kind, message };
}

export function reconcileBob2LastMessage(
  streamedAssistantText: string,
  lastMessage: string | undefined,
): string | undefined {
  if (!lastMessage || lastMessage === streamedAssistantText) return undefined;
  if (lastMessage.startsWith(streamedAssistantText)) {
    return lastMessage.slice(streamedAssistantText.length) || undefined;
  }
  if (streamedAssistantText.length === 0 || streamedAssistantText.startsWith(lastMessage)) {
    return streamedAssistantText.length === 0 ? lastMessage : undefined;
  }
  return undefined;
}
