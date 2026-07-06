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

/**
 * Build an adapter over a fake spawner with an open session and a background
 * event collector. `turnDone` resolves on the first `turn.completed` event.
 */
function makeAdapterHarness(
  fakeSpawner: ReturnType<typeof ChildProcessSpawner.make>,
  threadId: ThreadId,
) {
  return Effect.gen(function* () {
    const adapter = yield* makeBobAdapter(
      decodeBobSettings({ binaryPath: "bob", enabled: true }),
      { instanceId: ProviderInstanceId.make("bob") },
    ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fakeSpawner));

    const events: Array<ProviderRuntimeEvent> = [];
    const turnDone = yield* Deferred.make<void>();
    const firstItemStarted = yield* Deferred.make<void>();
    yield* Stream.runForEach(adapter.streamEvents, (event) =>
      Effect.sync(() => {
        events.push(event);
      }).pipe(
        Effect.andThen(
          event.type === "turn.completed"
            ? Deferred.succeed(turnDone, undefined)
            : event.type === "item.started"
              ? Deferred.succeed(firstItemStarted, undefined)
              : Effect.void,
        ),
      ),
    ).pipe(Effect.forkScoped);

    yield* adapter.startSession({
      threadId,
      provider: ProviderDriverKind.make("bob"),
      cwd: process.cwd(),
      runtimeMode: "full-access",
    });

    return { adapter, events, turnDone, firstItemStarted };
  });
}

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

  it.effect("fails the turn with the stderr tail when bob exits non-zero", () =>
    Effect.gen(function* () {
      // Bob crashes after init without ever printing a `result` event. The
      // turn must end as failed with the exit code and stderr in the message.
      // exitCode only resolves after the stderr chunk has been consumed, so the
      // adapter's stderr tail is deterministically populated.
      const stdout = `{"type":"init","session_id":"${SESSION_UUID}"}\n`;
      const stderrConsumed = yield* Deferred.make<void>();
      const fakeSpawner = ChildProcessSpawner.make(() =>
        Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode: Deferred.await(stderrConsumed).pipe(
              Effect.as(ChildProcessSpawner.ExitCode(2)),
            ),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.encodeText(Stream.make(stdout)),
            stderr: Stream.encodeText(Stream.make("boom: missing credentials\n")).pipe(
              Stream.concat(
                Stream.fromEffect(Deferred.succeed(stderrConsumed, undefined)).pipe(Stream.drain),
              ),
            ),
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          }),
        ),
      );
      const threadId = ThreadId.make("bob-exit-failure");
      const { adapter, events, turnDone } = yield* makeAdapterHarness(fakeSpawner, threadId);

      const turn = yield* adapter.sendTurn({ threadId, input: "hi" });
      assert.deepStrictEqual(turn.resumeCursor, { resumeSessionId: SESSION_UUID });
      yield* Deferred.await(turnDone).pipe(Effect.timeoutOption("5 seconds"));

      const turnCompleted = events.find((event) => event.type === "turn.completed");
      assert.isDefined(turnCompleted);
      if (turnCompleted?.type === "turn.completed") {
        assert.equal(turnCompleted.payload.state, "failed");
        assert.equal(
          turnCompleted.payload.errorMessage,
          "Bob exited with code 2: boom: missing credentials",
        );
      }
    }),
  );

  it.effect("fails the turn when bob reports a result error despite exit code 0", () =>
    Effect.gen(function* () {
      const stdout = [
        `{"type":"init","session_id":"${SESSION_UUID}"}`,
        '{"type":"result","status":"error","error":{"message":"quota exceeded"}}',
        "",
      ].join("\n");
      const fakeSpawner = ChildProcessSpawner.make(() => Effect.succeed(makeStdoutHandle(stdout)));
      const threadId = ThreadId.make("bob-result-error");
      const { adapter, events, turnDone } = yield* makeAdapterHarness(fakeSpawner, threadId);

      yield* adapter.sendTurn({ threadId, input: "hi" });
      yield* Deferred.await(turnDone).pipe(Effect.timeoutOption("5 seconds"));

      const turnCompleted = events.find((event) => event.type === "turn.completed");
      assert.isDefined(turnCompleted);
      if (turnCompleted?.type === "turn.completed") {
        assert.equal(turnCompleted.payload.state, "failed");
        assert.equal(turnCompleted.payload.errorMessage, "Bob: quota exceeded");
      }
    }),
  );

  it.effect("reassembles chunked lines and strips thinking tags split across messages", () =>
    Effect.gen(function* () {
      // The stream arrives in arbitrary chunks that cut JSON lines mid-way, the
      // last line has no trailing newline, and the `</thinking>` tag is split
      // across two message events. Reasoning deltas must come out clean and the
      // tail line must still be processed.
      const raw = [
        { type: "init", session_id: SESSION_UUID },
        { type: "message", role: "assistant", content: "<thinking>step one</thin" },
        { type: "message", role: "assistant", content: "king> more" },
        {
          type: "tool_use",
          tool_name: "attempt_completion",
          tool_id: "tool-done",
          parameters: { result: "Done." },
        },
        { type: "result", status: "success", stats: {} },
      ]
        .map((line) => JSON.stringify(line))
        .join("\n"); // no trailing newline: the final line goes through the tail flush
      const chunks = [raw.slice(0, 25), raw.slice(25, raw.length - 8), raw.slice(raw.length - 8)];
      const fakeSpawner = ChildProcessSpawner.make(() =>
        Effect.succeed(makeStreamStdoutHandle(Stream.encodeText(Stream.make(...chunks)))),
      );
      const threadId = ThreadId.make("bob-chunked-thinking");
      const { adapter, events, turnDone } = yield* makeAdapterHarness(fakeSpawner, threadId);

      yield* adapter.sendTurn({ threadId, input: "hi" });
      yield* Deferred.await(turnDone).pipe(Effect.timeoutOption("5 seconds"));

      const reasoningDeltas = events
        .filter(
          (event) =>
            event.type === "content.delta" && event.payload.streamKind === "reasoning_text",
        )
        .map((event) => (event.type === "content.delta" ? event.payload.delta : ""));
      assert.deepStrictEqual(reasoningDeltas, ["step one", " more"]);

      const assistantDeltas = events
        .filter(
          (event) =>
            event.type === "content.delta" && event.payload.streamKind === "assistant_text",
        )
        .map((event) => (event.type === "content.delta" ? event.payload.delta : ""));
      assert.deepStrictEqual(assistantDeltas, ["Done."]);

      const turnCompleted = events.find((event) => event.type === "turn.completed");
      assert.isDefined(turnCompleted);
      if (turnCompleted?.type === "turn.completed") {
        assert.equal(turnCompleted.payload.state, "completed");
      }
    }),
  );

  it.effect("interrupting a turn fails in-flight tools and rejects a concurrent turn", () =>
    Effect.gen(function* () {
      // Bob starts a command and then the stream hangs (tool never finishes).
      const prefix = [
        `{"type":"init","session_id":"${SESSION_UUID}"}`,
        '{"type":"tool_use","tool_name":"execute_command","tool_id":"tool-hang","parameters":{"command":"sleep 999"}}',
        "",
      ].join("\n");
      const fakeSpawner = ChildProcessSpawner.make(() =>
        Effect.succeed(
          makeStreamStdoutHandle(
            Stream.encodeText(Stream.make(prefix)).pipe(Stream.concat(Stream.never)),
          ),
        ),
      );
      const threadId = ThreadId.make("bob-interrupt");
      const { adapter, events, turnDone, firstItemStarted } = yield* makeAdapterHarness(
        fakeSpawner,
        threadId,
      );

      const turn = yield* adapter.sendTurn({ threadId, input: "hi" });

      // Wait until the pump fiber has processed the tool_use line — sendTurn
      // returns as soon as `init` arrives, which can be earlier.
      yield* Deferred.await(firstItemStarted);

      // A second turn while the first is running is rejected.
      const concurrentError = yield* adapter
        .sendTurn({ threadId, input: "another" })
        .pipe(Effect.flip);
      assert.equal(concurrentError._tag, "ProviderAdapterRequestError");

      yield* adapter.interruptTurn(threadId, turn.turnId);
      yield* Deferred.await(turnDone).pipe(Effect.timeoutOption("5 seconds"));

      const toolCompleted = events.find(
        (event) =>
          event.type === "item.completed" && event.payload.itemType === "command_execution",
      );
      assert.isDefined(toolCompleted);
      if (toolCompleted?.type === "item.completed") {
        assert.equal(toolCompleted.payload.status, "failed");
        assert.equal(
          toolCompleted.payload.detail,
          "Tool call interrupted before Bob returned a result.",
        );
      }

      const turnCompleted = events.find((event) => event.type === "turn.completed");
      assert.isDefined(turnCompleted);
      if (turnCompleted?.type === "turn.completed") {
        assert.equal(turnCompleted.payload.state, "interrupted");
      }
    }),
  );

  it.effect("fails tools left in flight when bob ends the turn without their results", () =>
    Effect.gen(function* () {
      const stdout = [
        `{"type":"init","session_id":"${SESSION_UUID}"}`,
        '{"type":"tool_use","tool_name":"read_file","tool_id":"tool-orphan","parameters":{"path":"a.ts"}}',
        '{"type":"result","status":"success","stats":{}}',
        "",
      ].join("\n");
      const fakeSpawner = ChildProcessSpawner.make(() => Effect.succeed(makeStdoutHandle(stdout)));
      const threadId = ThreadId.make("bob-orphan-tool");
      const { adapter, events, turnDone } = yield* makeAdapterHarness(fakeSpawner, threadId);

      yield* adapter.sendTurn({ threadId, input: "hi" });
      yield* Deferred.await(turnDone).pipe(Effect.timeoutOption("5 seconds"));

      const toolCompleted = events.find((event) => event.type === "item.completed");
      assert.isDefined(toolCompleted);
      if (toolCompleted?.type === "item.completed") {
        assert.equal(toolCompleted.payload.status, "failed");
        assert.equal(
          toolCompleted.payload.detail,
          "Bob ended the turn before returning a tool result.",
        );
      }

      const turnCompleted = events.find((event) => event.type === "turn.completed");
      assert.isDefined(turnCompleted);
      if (turnCompleted?.type === "turn.completed") {
        assert.equal(turnCompleted.payload.state, "completed");
      }
    }),
  );

  it.effect("rejects an empty prompt before spawning", () =>
    Effect.gen(function* () {
      let spawned = 0;
      const fakeSpawner = ChildProcessSpawner.make(() => {
        spawned += 1;
        return Effect.succeed(makeStdoutHandle(STREAM_JSON_LINES));
      });
      const threadId = ThreadId.make("bob-empty-prompt");
      const { adapter } = yield* makeAdapterHarness(fakeSpawner, threadId);

      const error = yield* adapter.sendTurn({ threadId, input: "   " }).pipe(Effect.flip);
      assert.equal(error._tag, "ProviderAdapterRequestError");
      assert.equal(spawned, 0);
    }),
  );

  it.effect("classifies tool names into canonical item types", () =>
    Effect.gen(function* () {
      const stdout = [
        { type: "init", session_id: SESSION_UUID },
        { type: "tool_use", tool_name: "write_to_file", tool_id: "t1", parameters: {} },
        { type: "tool_result", tool_id: "t1", status: "success", output: "" },
        { type: "tool_use", tool_name: "mcp_call", tool_id: "t2", parameters: {} },
        { type: "tool_result", tool_id: "t2", status: "success", output: "" },
        { type: "tool_use", tool_name: "web_fetch", tool_id: "t3", parameters: {} },
        { type: "tool_result", tool_id: "t3", status: "success", output: "" },
        { type: "tool_use", tool_name: "new_task", tool_id: "t4", parameters: {} },
        { type: "tool_result", tool_id: "t4", status: "success", output: "" },
        { type: "result", status: "success", stats: {} },
      ]
        .map((line) => JSON.stringify(line))
        .join("\n")
        .concat("\n");
      const fakeSpawner = ChildProcessSpawner.make(() => Effect.succeed(makeStdoutHandle(stdout)));
      const threadId = ThreadId.make("bob-tool-classification");
      const { adapter, events, turnDone } = yield* makeAdapterHarness(fakeSpawner, threadId);

      yield* adapter.sendTurn({ threadId, input: "hi" });
      yield* Deferred.await(turnDone).pipe(Effect.timeoutOption("5 seconds"));

      const startedTypes = events
        .filter((event) => event.type === "item.started")
        .map((event) => (event.type === "item.started" ? event.payload.itemType : ""));
      assert.deepStrictEqual(startedTypes, [
        "file_change",
        "mcp_tool_call",
        "web_search",
        "collab_agent_tool_call",
      ]);
    }),
  );

  it.effect("plan interaction mode overrides the configured chat mode", () =>
    Effect.gen(function* () {
      const spawnedArgs: Array<ReadonlyArray<string>> = [];
      const fakeSpawner = ChildProcessSpawner.make((command) => {
        spawnedArgs.push(asChildProcessCommand(command).args);
        return Effect.succeed(makeStdoutHandle(STREAM_JSON_LINES));
      });
      const threadId = ThreadId.make("bob-plan-mode");
      const { adapter, turnDone } = yield* makeAdapterHarness(fakeSpawner, threadId);

      yield* adapter.sendTurn({ threadId, input: "hi", interactionMode: "plan" });
      yield* Deferred.await(turnDone).pipe(Effect.timeoutOption("5 seconds"));

      assert.equal(spawnedArgs.length, 1);
      const args = spawnedArgs[0] ?? [];
      const chatModeIndex = args.indexOf("--chat-mode");
      assert.equal(args[chatModeIndex + 1], "plan");
    }),
  );
});
