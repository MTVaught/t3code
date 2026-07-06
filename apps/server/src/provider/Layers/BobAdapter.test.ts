import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert } from "@effect/vitest";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  BobSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  ThreadId,
} from "@t3tools/contracts";

import {
  buildBobTurnArgs,
  makeBobAdapter,
  makeBobTokenUsageSnapshot,
  readBobAssistantMessage,
  readBobInitSessionId,
  readBobResultError,
  readBobToolResult,
  readBobToolUse,
} from "./BobAdapter.ts";

const decodeBobSettings = Schema.decodeSync(BobSettings);

type ChildProcessCommand = {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
};

function asChildProcessCommand(command: unknown): ChildProcessCommand {
  return command as ChildProcessCommand;
}

function makeStdoutHandle(stdout: string) {
  return makeStreamStdoutHandle(Stream.encodeText(Stream.make(stdout)));
}

function makeStreamStdoutHandle(stdout: Stream.Stream<Uint8Array>) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout,
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

const SESSION_UUID = "aec50d67-403c-4d08-a624-596bbd18a339";

const STREAM_JSON_LINES = [
  { type: "init", session_id: SESSION_UUID, model: "premium" },
  { type: "message", role: "user", content: "hi" },
  { type: "message", role: "assistant", content: "Hello", delta: true },
  { type: "message", role: "assistant", content: " world", delta: true },
  { type: "message", role: "assistant", content: "[using tool read_file: ...]\n", delta: true },
  { type: "tool_use", tool_name: "read_file", tool_id: "tool-1", parameters: { path: "a.ts" } },
  // bob frequently emits an empty `output` for reads — the completed event must
  // still carry the request input so the work-log row is not a bare "Tool call".
  { type: "tool_result", tool_id: "tool-1", status: "success", output: "" },
  {
    type: "tool_use",
    tool_name: "execute_command",
    tool_id: "tool-command",
    parameters: { command: "echo hi" },
  },
  { type: "tool_result", tool_id: "tool-command", status: "success", output: "hi\n" },
  {
    type: "tool_use",
    tool_name: "attempt_completion",
    tool_id: "tool-2",
    parameters: { result: "All done." },
  },
  {
    type: "result",
    status: "success",
    stats: {
      total_tokens: 100,
      input_tokens: 80,
      output_tokens: 20,
      duration_ms: 1234,
      tool_calls: 2,
      session_costs: 0.05,
    },
  },
]
  .map((line) => JSON.stringify(line))
  .join("\n")
  .concat("\n");

const bobTestLayer = NodeServices.layer;

it.layer(bobTestLayer)("BobAdapter", (it) => {
  it("builds bob turn args", () => {
    assert.deepStrictEqual(
      buildBobTurnArgs({
        prompt: "hi",
        tier: "premium",
        chatMode: "code",
        approvalMode: "default",
        maxCoins: "",
      }),
      ["-p", "hi", "-o", "stream-json", "-m", "premium", "--chat-mode", "code"],
    );
    assert.deepStrictEqual(
      buildBobTurnArgs({
        prompt: "hi",
        tier: "premium",
        chatMode: "code",
        approvalMode: "auto_edit",
        maxCoins: " 25 ",
        resumeSessionId: SESSION_UUID,
      }),
      [
        "-p",
        "hi",
        "-o",
        "stream-json",
        "-m",
        "premium",
        "--chat-mode",
        "code",
        "--approval-mode",
        "auto_edit",
        "--max-coins",
        "25",
        "-r",
        SESSION_UUID,
      ],
    );
    assert.isTrue(
      buildBobTurnArgs({
        prompt: "hi",
        tier: "premium",
        chatMode: "code",
        approvalMode: "yolo",
        maxCoins: "",
      }).includes("--yolo"),
    );
  });

  it("reads bob stream fields through pure helpers", () => {
    assert.equal(readBobInitSessionId({ session_id: SESSION_UUID }), SESSION_UUID);
    assert.equal(readBobInitSessionId({ session_id: "not-a-uuid" }), undefined);
    assert.equal(readBobAssistantMessage({ role: "assistant", content: "hello" }), "hello");
    assert.equal(readBobAssistantMessage({ role: "user", content: "hello" }), undefined);
    assert.deepStrictEqual(
      readBobToolUse({ tool_name: "read_file", parameters: { path: "a.ts" } }, "fallback"),
      {
        toolName: "read_file",
        toolId: "fallback",
        parameters: { path: "a.ts" },
      },
    );
    assert.deepStrictEqual(
      readBobToolResult({ tool_id: "tool-1", status: "success", output: "" }),
      { toolId: "tool-1", status: "success", output: undefined },
    );
    assert.equal(readBobResultError({ error: "failed" }), "failed");
    assert.equal(readBobResultError({ error: { message: "failed object" } }), "failed object");
  });

  it("maps bob token stats to thread token usage", () => {
    assert.deepStrictEqual(
      makeBobTokenUsageSnapshot({
        stats: {
          total_tokens: 100,
          input_tokens: 80,
          output_tokens: 20,
          duration_ms: 1234,
          tool_calls: 1,
        },
        contextWindowTokens: 200_000,
      }),
      {
        usedTokens: 80,
        maxTokens: 200_000,
        compactsAutomatically: true,
        totalProcessedTokens: 100,
        inputTokens: 80,
        outputTokens: 20,
        durationMs: 1234,
        toolUses: 1,
      },
    );
    assert.equal(
      makeBobTokenUsageSnapshot({
        stats: { total_tokens: -1, input_tokens: Number.NaN },
        contextWindowTokens: 200_000,
      }),
      undefined,
    );
  });

  it.effect("rejects attachments and rollback instead of silently diverging from Bob", () =>
    Effect.gen(function* () {
      const fakeSpawner = ChildProcessSpawner.make(() =>
        Effect.succeed(makeStdoutHandle(STREAM_JSON_LINES)),
      );
      const adapter = yield* makeBobAdapter(
        decodeBobSettings({ binaryPath: "bob", enabled: true }),
        { instanceId: ProviderInstanceId.make("bob") },
      ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fakeSpawner));
      const threadId = ThreadId.make("bob-unsupported-operations");
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("bob"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const attachmentError = yield* adapter
        .sendTurn({
          threadId,
          input: "describe this",
          attachments: [
            {
              type: "image",
              id: "attachment-1",
              name: "probe.png",
              mimeType: "image/png",
              sizeBytes: 1,
            },
          ],
        })
        .pipe(Effect.flip);
      assert.equal(attachmentError._tag, "ProviderAdapterValidationError");

      const rollbackError = yield* adapter.rollbackThread(threadId, 1).pipe(Effect.flip);
      assert.equal(rollbackError._tag, "ProviderAdapterRequestError");
    }),
  );

  it.effect("maps a stream-json turn to canonical runtime events", () =>
    Effect.gen(function* () {
      const spawnedArgs: Array<ReadonlyArray<string>> = [];
      const fakeSpawner = ChildProcessSpawner.make((command) => {
        spawnedArgs.push(asChildProcessCommand(command).args);
        return Effect.succeed(makeStdoutHandle(STREAM_JSON_LINES));
      });

      const adapter = yield* makeBobAdapter(
        decodeBobSettings({ binaryPath: "bob", enabled: true, approvalMode: "yolo" }),
        { instanceId: ProviderInstanceId.make("bob") },
      ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fakeSpawner));

      const events: Array<ProviderRuntimeEvent> = [];
      const turnDone = yield* Deferred.make<void>();
      yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          events.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "turn.completed" ? Deferred.succeed(turnDone, undefined) : Effect.void,
          ),
        ),
      ).pipe(Effect.forkScoped);

      const threadId = ThreadId.make("bob-test-thread");
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("bob"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId,
        input: "hi",
        modelSelection: { instanceId: ProviderInstanceId.make("bob"), model: "premium" },
      });
      assert.deepStrictEqual(turn.resumeCursor, {
        resumeSessionId: SESSION_UUID,
      });

      yield* Deferred.await(turnDone).pipe(Effect.timeoutOption("5 seconds"));

      const types = events.map((event) => event.type);

      // Intermediary assistant `message` text is mapped to the reasoning stream,
      // NOT the assistant answer.
      const reasoningDeltas = events.filter(
        (event) => event.type === "content.delta" && event.payload.streamKind === "reasoning_text",
      );
      assert.deepStrictEqual(
        reasoningDeltas.map((event) => (event.type === "content.delta" ? event.payload.delta : "")),
        ["Hello", " world"],
      );

      // The actual answer (attempt_completion.result) is streamed as assistant_text.
      const assistantDeltas = events.filter(
        (event) => event.type === "content.delta" && event.payload.streamKind === "assistant_text",
      );
      assert.deepStrictEqual(
        assistantDeltas.map((event) => (event.type === "content.delta" ? event.payload.delta : "")),
        ["All done."],
      );

      // The read_file tool produced a started + completed lifecycle pair, each
      // carrying the structured tool content (`{ toolName, input, result }`) so
      // the UI can render the call.
      const toolStarted = events.find((event) => event.type === "item.started");
      assert.isDefined(toolStarted);
      if (toolStarted?.type === "item.started") {
        assert.deepStrictEqual(toolStarted.payload.data, {
          toolName: "read_file",
          input: { path: "a.ts" },
        });
        assert.equal(toolStarted.payload.detail, "read_file: a.ts");
      }

      const toolCompleted = events.find(
        (event) =>
          event.type === "item.completed" && event.payload.itemType === "dynamic_tool_call",
      );
      assert.isDefined(toolCompleted);
      if (toolCompleted?.type === "item.completed") {
        // No `result` when bob's output is empty, but the input is preserved and
        // the detail falls back to the request summary (instead of being blank).
        assert.deepStrictEqual(toolCompleted.payload.data, {
          toolName: "read_file",
          input: { path: "a.ts" },
        });
        assert.equal(toolCompleted.payload.detail, "read_file: a.ts");
      }

      const commandCompleted = events.find(
        (event) =>
          event.type === "item.completed" && event.payload.itemType === "command_execution",
      );
      assert.isDefined(commandCompleted);
      if (commandCompleted?.type === "item.completed") {
        assert.deepStrictEqual(commandCompleted.payload.data, {
          toolName: "execute_command",
          input: { command: "echo hi" },
          command: "echo hi",
          result: "hi",
        });
        assert.equal(commandCompleted.payload.title, "Command run");
        assert.equal(commandCompleted.payload.detail, "execute_command: echo hi");
      }

      // Final assistant message uses the attempt_completion result, not the reasoning.
      const assistantCompleted = events.find(
        (event) =>
          event.type === "item.completed" && event.payload.itemType === "assistant_message",
      );
      assert.isDefined(assistantCompleted);
      if (assistantCompleted?.type === "item.completed") {
        assert.equal(assistantCompleted.payload.detail, "All done.");
      }

      // Token usage mapped from result stats. `usedTokens` is the live context
      // occupancy (bob's `input_tokens`), `totalProcessedTokens` is `total_tokens`,
      // and `maxTokens` is bob's context window (200,000) since bob never reports
      // the window size in its stream output.
      const usage = events.find((event) => event.type === "thread.token-usage.updated");
      assert.isDefined(usage);
      if (usage?.type === "thread.token-usage.updated") {
        assert.equal(usage.payload.usage.usedTokens, 80);
        assert.equal(usage.payload.usage.maxTokens, 200_000);
        assert.equal(usage.payload.usage.totalProcessedTokens, 100);
        assert.equal(usage.payload.usage.inputTokens, 80);
        assert.equal(usage.payload.usage.outputTokens, 20);
        assert.equal(usage.payload.usage.compactsAutomatically, true);
      }

      // Turn completed successfully with cost.
      const turnCompleted = events.find((event) => event.type === "turn.completed");
      assert.isDefined(turnCompleted);
      if (turnCompleted?.type === "turn.completed") {
        assert.equal(turnCompleted.payload.state, "completed");
        assert.equal(turnCompleted.payload.totalCostUsd, 0.05);
      }

      assert.isTrue(types.includes("turn.started"));

      // Spawn args carry the resolved tier, stream-json format, and yolo approval.
      assert.equal(spawnedArgs.length, 1);
      const args = spawnedArgs[0] ?? [];
      assert.isTrue(args.includes("stream-json"));
      assert.isTrue(args.includes("--yolo"));
      const modelIndex = args.indexOf("-m");
      assert.equal(args[modelIndex + 1], "premium");
    }),
  );

  it.effect("waits for a slow init before returning the resume cursor", () =>
    Effect.gen(function* () {
      // Hold back all of Bob's stdout until after sendTurn is already running,
      // simulating a slow-starting Bob. sendTurn must keep waiting for `init`
      // (no fixed deadline) and return the session id it eventually produces.
      const releaseStdout = yield* Deferred.make<void>();
      const fakeSpawner = ChildProcessSpawner.make(() =>
        Effect.succeed(
          makeStreamStdoutHandle(
            Stream.fromEffect(Deferred.await(releaseStdout)).pipe(
              Stream.drain,
              Stream.concat(Stream.encodeText(Stream.make(STREAM_JSON_LINES))),
            ),
          ),
        ),
      );
      const adapter = yield* makeBobAdapter(
        decodeBobSettings({ binaryPath: "bob", enabled: true }),
        { instanceId: ProviderInstanceId.make("bob") },
      ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fakeSpawner));

      const threadId = ThreadId.make("bob-slow-init");
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("bob"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const turnFiber = yield* adapter.sendTurn({ threadId, input: "hi" }).pipe(Effect.forkChild);
      yield* Deferred.succeed(releaseStdout, undefined);
      const turn = yield* Fiber.join(turnFiber);
      assert.deepStrictEqual(turn.resumeCursor, { resumeSessionId: SESSION_UUID });
    }),
  );

  it.effect("returns without a resume cursor when bob exits without an init id", () =>
    Effect.gen(function* () {
      // Bob's stream ends without ever printing `init`; sendTurn must unblock
      // when the turn completes instead of hanging, and report no cursor.
      const stdout = '{"type":"result","status":"success","stats":{}}\n';
      const fakeSpawner = ChildProcessSpawner.make(() => Effect.succeed(makeStdoutHandle(stdout)));
      const adapter = yield* makeBobAdapter(
        decodeBobSettings({ binaryPath: "bob", enabled: true }),
        { instanceId: ProviderInstanceId.make("bob") },
      ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fakeSpawner));

      const threadId = ThreadId.make("bob-no-init");
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("bob"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({ threadId, input: "hi" });
      assert.equal(turn.resumeCursor, undefined);
    }),
  );
});
