import {
  ApprovalRequestId,
  EventId,
  type ProviderApprovalDecision,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  RuntimeRequestId,
  type RuntimeMode,
  type ServerProviderMode,
  type ServerProviderProjectMetadata,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { mapAcpToAdapterError, selectAcpPermissionOptionId } from "../acp/AcpAdapterSupport.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpToolCallEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";
import { parsePermissionRequest } from "../acp/AcpRuntimeModel.ts";
import type * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";

const RESUME_SCHEMA_VERSION = 1 as const;

interface PendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
}

interface SessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionRuntime.AcpSessionRuntime["Service"];
  readonly startInput: Parameters<ProviderAdapterShape<ProviderAdapterError>["startSession"]>[0];
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  activeTurnId: TurnId | undefined;
  lastPlanFingerprint: string | undefined;
  promptInFlight: boolean;
  suppressTurnEvents: boolean;
  stopped: boolean;
}

export interface BasicAcpAdapterOptions {
  readonly provider: ProviderDriverKind;
  readonly instanceId: ProviderInstanceId;
  readonly displayName: string;
  readonly builtInModes: ReadonlyArray<ServerProviderMode>;
  readonly makeRuntime: (input: {
    readonly threadId: ThreadId;
    readonly cwd: string;
    readonly resumeSessionId?: string;
    readonly mcpServers?: ReadonlyArray<EffectAcpSchema.McpServer>;
    readonly scope: Scope.Closeable;
  }) => Effect.Effect<AcpSessionRuntime.AcpSessionRuntime["Service"], ProviderAdapterError>;
}

function parseResumeCursor(value: unknown): { sessionId: string } | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const cursor = value as Record<string, unknown>;
  if (cursor.schemaVersion !== RESUME_SCHEMA_VERSION) return undefined;
  return typeof cursor.sessionId === "string" && cursor.sessionId.trim()
    ? { sessionId: cursor.sessionId.trim() }
    : undefined;
}

function shouldAutoApprove(runtimeMode: RuntimeMode, kind: string): boolean {
  if (runtimeMode === "full-access") return true;
  if (runtimeMode === "approval-required") return false;
  return kind === "edit" || kind === "delete" || kind === "move";
}

export const makeBasicAcpAdapter = Effect.fn("makeBasicAcpAdapter")(function* (
  options: BasicAcpAdapterOptions,
): Effect.fn.Return<
  ProviderAdapterShape<ProviderAdapterError>,
  never,
  Crypto.Crypto | FileSystem.FileSystem | Path.Path | Scope.Scope | ServerConfig
> {
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig;
  const sessions = new Map<ThreadId, SessionContext>();
  const metadataByCwd = new Map<string, ServerProviderProjectMetadata>();
  const locks = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
  const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const randomId = crypto.randomUUIDv4.pipe(
    Effect.mapError(
      (cause) =>
        new ProviderAdapterRequestError({
          provider: options.provider,
          method: "crypto/randomUUIDv4",
          detail: `Failed to create a ${options.displayName} runtime identifier.`,
          cause,
        }),
    ),
  );
  const stamp = () =>
    Effect.all({ eventId: Effect.map(randomId, EventId.make), createdAt: nowIso });
  const publish = (event: ProviderRuntimeEvent) =>
    PubSub.publish(events, event).pipe(Effect.asVoid);

  const getLock = (threadId: string) =>
    SynchronizedRef.modifyEffect(locks, (current) => {
      const existing = current.get(threadId);
      if (existing) return Effect.succeed([existing, current] as const);
      return Semaphore.make(1).pipe(
        Effect.map((semaphore) => {
          const next = new Map(current);
          next.set(threadId, semaphore);
          return [semaphore, next] as const;
        }),
      );
    });
  const withLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
    Effect.flatMap(getLock(threadId), (lock) => lock.withPermit(effect));

  const requireSession = (threadId: ThreadId) => {
    const context = sessions.get(threadId);
    return context && !context.stopped
      ? Effect.succeed(context)
      : Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: options.provider, threadId }),
        );
  };

  const stopInternal = Effect.fn("BasicAcpAdapter.stopInternal")(function* (
    context: SessionContext,
    graceful = true,
  ) {
    if (context.stopped) return;
    context.stopped = true;
    for (const pending of context.pendingApprovals.values()) {
      yield* Deferred.succeed(pending.decision, "cancel").pipe(Effect.ignore);
    }
    if (graceful) {
      yield* context.acp.close.pipe(Effect.ignore);
    } else {
      yield* context.acp.terminate;
    }
    if (context.notificationFiber) yield* Fiber.interrupt(context.notificationFiber);
    yield* Scope.close(context.scope, Exit.void).pipe(Effect.ignore);
    sessions.delete(context.threadId);
    yield* publish({
      type: "session.exited",
      ...(yield* stamp()),
      provider: options.provider,
      threadId: context.threadId,
      payload: { exitKind: "graceful" },
    });
  });

  const startSession: ProviderAdapterShape<ProviderAdapterError>["startSession"] = (input) =>
    withLock(
      input.threadId,
      Effect.gen(function* () {
        if (input.provider !== undefined && input.provider !== options.provider) {
          return yield* new ProviderAdapterValidationError({
            provider: options.provider,
            operation: "startSession",
            issue: `Expected provider '${options.provider}' but received '${input.provider}'.`,
          });
        }
        if (!input.cwd?.trim()) {
          return yield* new ProviderAdapterValidationError({
            provider: options.provider,
            operation: "startSession",
            issue: "cwd is required and must be non-empty.",
          });
        }
        const cwd = path.resolve(input.cwd.trim());
        const existing = sessions.get(input.threadId);
        if (existing && !existing.stopped) yield* stopInternal(existing);

        const sessionScope = yield* Scope.make("sequential");
        let transferred = false;
        yield* Effect.addFinalizer(() =>
          transferred ? Effect.void : Scope.close(sessionScope, Exit.void),
        );
        const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
        const resumeSessionId = parseResumeCursor(input.resumeCursor)?.sessionId;
        const mcp = McpProviderSession.readMcpProviderSession(input.threadId);
        const mcpServers = mcp
          ? [
              {
                type: "http" as const,
                name: "t3-code",
                url: mcp.endpoint,
                headers: [{ name: "Authorization", value: mcp.authorizationHeader }],
              },
            ]
          : undefined;
        const acp = yield* options.makeRuntime({
          threadId: input.threadId,
          cwd,
          ...(resumeSessionId ? { resumeSessionId } : {}),
          ...(mcpServers ? { mcpServers } : {}),
          scope: sessionScope,
        });
        let context!: SessionContext;
        yield* acp.handleRequestPermission((params) =>
          Effect.gen(function* () {
            const permission = parsePermissionRequest(params);
            if (shouldAutoApprove(input.runtimeMode, permission.kind)) {
              const optionId =
                selectAcpPermissionOptionId(params, "acceptForSession") ??
                selectAcpPermissionOptionId(params, "accept");
              if (optionId) return { outcome: { outcome: "selected" as const, optionId } };
            }
            const requestId = ApprovalRequestId.make(yield* randomId);
            const decision = yield* Deferred.make<ProviderApprovalDecision>();
            pendingApprovals.set(requestId, { decision });
            yield* publish(
              makeAcpRequestOpenedEvent({
                stamp: yield* stamp(),
                provider: options.provider,
                threadId: input.threadId,
                turnId: context?.activeTurnId,
                requestId: RuntimeRequestId.make(requestId),
                permissionRequest: permission,
                detail: permission.detail ?? "Provider requests permission to use a tool.",
                args: params,
                source: "acp.jsonrpc",
                method: "session/request_permission",
                rawPayload: params,
              }),
            );
            const resolved = yield* Deferred.await(decision);
            pendingApprovals.delete(requestId);
            yield* publish(
              makeAcpRequestResolvedEvent({
                stamp: yield* stamp(),
                provider: options.provider,
                threadId: input.threadId,
                turnId: context?.activeTurnId,
                requestId: RuntimeRequestId.make(requestId),
                permissionRequest: permission,
                decision: resolved,
              }),
            );
            if (resolved === "cancel") return { outcome: { outcome: "cancelled" as const } };
            const optionId = selectAcpPermissionOptionId(params, resolved);
            return optionId
              ? { outcome: { outcome: "selected" as const, optionId } }
              : { outcome: { outcome: "cancelled" as const } };
          }).pipe(
            Effect.mapError(
              (cause) =>
                new EffectAcpErrors.AcpTransportError({
                  detail: `Failed to process ${options.displayName} permission request.`,
                  cause,
                }),
            ),
          ),
        );
        const started = yield* acp
          .start()
          .pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(options.provider, input.threadId, "session/start", error),
            ),
          );
        const requestedMode = input.providerMode?.trim();
        const modeState = yield* acp.getModeState;
        if (
          requestedMode &&
          modeState &&
          modeState.currentModeId !== requestedMode &&
          modeState.availableModes.some((mode) => mode.id === requestedMode)
        ) {
          yield* acp
            .setMode(requestedMode)
            .pipe(
              Effect.mapError((error) =>
                mapAcpToAdapterError(options.provider, input.threadId, "session/set_mode", error),
              ),
            );
        }
        if (modeState) {
          metadataByCwd.set(cwd, {
            workspaceTrusted: true,
            modes: modeState.availableModes.map((mode) => ({
              slug: mode.id,
              name: mode.name,
              ...(mode.description ? { description: mode.description } : {}),
              scope: "workspace" as const,
            })),
            slashCommands: [],
            skills: [],
          });
        }
        const now = yield* nowIso;
        const session: ProviderSession = {
          provider: options.provider,
          providerInstanceId: options.instanceId,
          status: "ready",
          runtimeMode: input.runtimeMode,
          cwd,
          model: input.modelSelection?.model,
          threadId: input.threadId,
          resumeCursor: { schemaVersion: RESUME_SCHEMA_VERSION, sessionId: started.sessionId },
          createdAt: now,
          updatedAt: now,
        };
        context = {
          threadId: input.threadId,
          session,
          scope: sessionScope,
          acp,
          startInput: input,
          pendingApprovals,
          turns: [],
          notificationFiber: undefined,
          activeTurnId: undefined,
          lastPlanFingerprint: undefined,
          promptInFlight: false,
          suppressTurnEvents: false,
          stopped: false,
        };
        context.notificationFiber = yield* Stream.runDrain(
          Stream.mapEffect(acp.getEvents(), (event) =>
            Effect.gen(function* () {
              switch (event._tag) {
                case "EventStreamBarrier":
                  yield* Deferred.succeed(event.acknowledge, undefined);
                  return;
                case "ModeChanged":
                  yield* publish({
                    type: "thread.metadata.updated",
                    ...(yield* stamp()),
                    provider: options.provider,
                    providerInstanceId: options.instanceId,
                    threadId: context.threadId,
                    payload: { metadata: { providerMode: event.modeId } },
                  });
                  return;
                case "AvailableCommandsChanged": {
                  const existing = metadataByCwd.get(cwd) ?? {
                    workspaceTrusted: true,
                    modes: [...options.builtInModes],
                    slashCommands: [],
                    skills: [],
                  };
                  metadataByCwd.set(cwd, {
                    ...existing,
                    slashCommands: event.commands.map((command) => ({
                      name: command.name,
                      ...(command.description ? { description: command.description } : {}),
                      ...(command.inputHint ? { input: { hint: command.inputHint } } : {}),
                    })),
                  });
                  return;
                }
                case "AssistantItemStarted":
                case "AssistantItemCompleted":
                  if (context.suppressTurnEvents) return;
                  yield* publish(
                    makeAcpAssistantItemEvent({
                      stamp: yield* stamp(),
                      provider: options.provider,
                      threadId: context.threadId,
                      turnId: context.activeTurnId,
                      itemId: event.itemId,
                      lifecycle:
                        event._tag === "AssistantItemStarted" ? "item.started" : "item.completed",
                    }),
                  );
                  return;
                case "PlanUpdated": {
                  if (context.suppressTurnEvents) return;
                  const fingerprint = event.payload.plan
                    .map((entry) => `${entry.status}:${entry.step}`)
                    .join("\n");
                  if (fingerprint === context.lastPlanFingerprint) return;
                  context.lastPlanFingerprint = fingerprint;
                  yield* publish(
                    makeAcpPlanUpdatedEvent({
                      stamp: yield* stamp(),
                      provider: options.provider,
                      threadId: context.threadId,
                      turnId: context.activeTurnId,
                      payload: event.payload,
                      source: "acp.jsonrpc",
                      method: "session/update",
                      rawPayload: event.rawPayload,
                    }),
                  );
                  return;
                }
                case "ToolCallUpdated":
                  if (context.suppressTurnEvents) return;
                  yield* publish(
                    makeAcpToolCallEvent({
                      stamp: yield* stamp(),
                      provider: options.provider,
                      threadId: context.threadId,
                      turnId: context.activeTurnId,
                      toolCall: event.toolCall,
                      rawPayload: event.rawPayload,
                    }),
                  );
                  return;
                case "ContentDelta":
                  if (context.suppressTurnEvents) return;
                  yield* publish(
                    makeAcpContentDeltaEvent({
                      stamp: yield* stamp(),
                      provider: options.provider,
                      threadId: context.threadId,
                      turnId: context.activeTurnId,
                      ...(event.itemId ? { itemId: event.itemId } : {}),
                      streamKind: event.streamKind,
                      text: event.text,
                      rawPayload: event.rawPayload,
                    }),
                  );
                  return;
              }
            }),
          ),
        ).pipe(
          Effect.catch((cause) =>
            Effect.logError(`Failed to process ${options.displayName} ACP event.`, { cause }),
          ),
          Effect.forkChild,
        );
        sessions.set(input.threadId, context);
        transferred = true;
        yield* publish({
          type: "session.started",
          ...(yield* stamp()),
          provider: options.provider,
          threadId: input.threadId,
          payload: { resume: started.initializeResult },
        });
        yield* publish({
          type: "session.state.changed",
          ...(yield* stamp()),
          provider: options.provider,
          threadId: input.threadId,
          payload: { state: "ready", reason: `${options.displayName} ACP session ready` },
        });
        yield* publish({
          type: "thread.started",
          ...(yield* stamp()),
          provider: options.provider,
          threadId: input.threadId,
          payload: { providerThreadId: started.sessionId },
        });
        return session;
      }).pipe(Effect.scoped),
    );

  const sendTurn: ProviderAdapterShape<ProviderAdapterError>["sendTurn"] = (input) =>
    Effect.gen(function* () {
      const context = yield* requireSession(input.threadId);
      if (context.promptInFlight) {
        return yield* new ProviderAdapterRequestError({
          provider: options.provider,
          method: "session/prompt",
          detail: `${options.displayName} does not support steering a running turn.`,
        });
      }
      const prompt: Array<EffectAcpSchema.ContentBlock> = [];
      if (input.input?.trim()) prompt.push({ type: "text", text: input.input.trim() });
      for (const attachment of input.attachments ?? []) {
        const attachmentPath = resolveAttachmentPath({
          attachmentsDir: serverConfig.attachmentsDir,
          attachment,
        });
        if (!attachmentPath) {
          return yield* new ProviderAdapterRequestError({
            provider: options.provider,
            method: "session/prompt",
            detail: `Invalid attachment id '${attachment.id}'.`,
          });
        }
        const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterRequestError({
                provider: options.provider,
                method: "session/prompt",
                detail: cause.message,
                cause,
              }),
          ),
        );
        prompt.push({
          type: "image",
          data: Buffer.from(bytes).toString("base64"),
          mimeType: attachment.mimeType,
        });
      }
      if (prompt.length === 0) {
        return yield* new ProviderAdapterValidationError({
          provider: options.provider,
          operation: "sendTurn",
          issue: "Turn requires non-empty text or attachments.",
        });
      }
      const requestedMode = input.providerMode?.trim();
      if (requestedMode) {
        yield* context.acp
          .setMode(requestedMode)
          .pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(options.provider, input.threadId, "session/set_mode", error),
            ),
          );
      }
      const turnId = TurnId.make(yield* randomId);
      context.activeTurnId = turnId;
      context.promptInFlight = true;
      context.suppressTurnEvents = false;
      context.lastPlanFingerprint = undefined;
      context.session = {
        ...context.session,
        status: "running",
        activeTurnId: turnId,
        updatedAt: yield* nowIso,
      };
      yield* publish({
        type: "turn.started",
        ...(yield* stamp()),
        provider: options.provider,
        threadId: input.threadId,
        turnId,
        payload: { model: context.session.model ?? "provider-managed" },
      });
      return yield* Effect.gen(function* () {
        const result = context.suppressTurnEvents
          ? ({ stopReason: "cancelled" } as const)
          : yield* context.acp
              .prompt({ prompt })
              .pipe(
                Effect.mapError((error) =>
                  mapAcpToAdapterError(options.provider, input.threadId, "session/prompt", error),
                ),
              );
        context.turns.push({ id: turnId, items: [{ prompt, result }] });
        context.session = {
          ...context.session,
          status: "ready",
          activeTurnId: turnId,
          updatedAt: yield* nowIso,
        };
        yield* publish({
          type: "turn.completed",
          ...(yield* stamp()),
          provider: options.provider,
          threadId: input.threadId,
          turnId,
          payload: {
            state: result.stopReason === "cancelled" ? "cancelled" : "completed",
            stopReason: result.stopReason ?? null,
          },
        });
        return { threadId: input.threadId, turnId, resumeCursor: context.session.resumeCursor };
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            context.promptInFlight = false;
            if (context.session.status === "running") {
              context.session = {
                ...context.session,
                status: "ready",
                updatedAt: yield* nowIso,
              };
            }
          }),
        ),
      );
    });

  const stopSession = (threadId: ThreadId) =>
    withLock(threadId, Effect.flatMap(requireSession(threadId), stopInternal));

  const adapter: ProviderAdapterShape<ProviderAdapterError> = {
    provider: options.provider,
    capabilities: {
      sessionModelSwitch: "unsupported",
      conversationRollback: false,
      midTurnSteering: false,
      interactiveApprovals: true,
      structuredUserInput: false,
      t3McpInjection: true,
      attachments: true,
    },
    getProjectMetadata: (cwd) =>
      Effect.succeed(
        metadataByCwd.get(path.resolve(cwd)) ?? {
          workspaceTrusted: true,
          modes: [...options.builtInModes],
          slashCommands: [],
          skills: [],
        },
      ),
    resetContext: (threadId) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        const startInput = { ...context.startInput, resumeCursor: undefined };
        yield* stopSession(threadId);
        return yield* startSession(startInput);
      }),
    startSession,
    sendTurn,
    interruptTurn: (threadId) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        context.suppressTurnEvents = true;
        for (const pending of context.pendingApprovals.values()) {
          yield* Deferred.succeed(pending.decision, "cancel").pipe(Effect.ignore);
        }
        yield* stopInternal(context, false);
      }),
    respondToRequest: (threadId, requestId, decision) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        const pending = context.pendingApprovals.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: options.provider,
            method: "session/request_permission",
            detail: `Unknown pending approval request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.decision, decision);
      }),
    respondToUserInput: (_threadId) =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: options.provider,
          method: "session/elicitation",
          detail: `${options.displayName} does not support structured user input.`,
        }),
      ),
    stopSession,
    listSessions: () =>
      Effect.sync(() => [...sessions.values()].map((ctx) => ({ ...ctx.session }))),
    hasSession: (threadId) =>
      Effect.sync(() => {
        const context = sessions.get(threadId);
        return context !== undefined && !context.stopped;
      }),
    readThread: (threadId) =>
      Effect.map(requireSession(threadId), (context) => ({
        threadId,
        turns: context.turns,
      })),
    rollbackThread: (threadId, numTurns) =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: options.provider,
          method: "thread/rollback",
          detail: `${options.displayName} cannot roll back ${numTurns} turn(s) in its ACP session.`,
        }),
      ),
    stopAll: () => Effect.forEach(sessions.values(), stopInternal, { discard: true }),
    streamEvents: Stream.fromPubSub(events),
  };

  yield* Effect.addFinalizer(() =>
    adapter.stopAll().pipe(
      Effect.catch((cause) =>
        Effect.logError(`Failed to stop ${options.displayName} ACP sessions.`, { cause }),
      ),
      Effect.tap(() => PubSub.shutdown(events)),
    ),
  );
  return adapter;
});
