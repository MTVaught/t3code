import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert } from "@effect/vitest";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
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

import { makeBobAdapter } from "./BobAdapter.ts";

const decodeBobSettings = Schema.decodeSync(BobSettings);

type ChildProcessCommand = {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
};

function asChildProcessCommand(command: unknown): ChildProcessCommand {
  return command as ChildProcessCommand;
}

function makeStdoutHandle(stdout: string) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.encodeText(Stream.make(stdout)),
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
  { type: "tool_result", tool_id: "tool-1", status: "success", output: "file contents" },
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
      tool_calls: 1,
      session_costs: 0.05,
    },
  },
]
  .map((line) => JSON.stringify(line))
  .join("\n")
  .concat("\n");

const bobTestLayer = NodeServices.layer;

it.layer(bobTestLayer)("BobAdapter", (it) => {
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

      yield* adapter.sendTurn({
        threadId,
        input: "hi",
        modelSelection: { instanceId: ProviderInstanceId.make("bob"), model: "premium" },
      });

      yield* Deferred.await(turnDone).pipe(Effect.timeoutOption("5 seconds"));

      const types = events.map((event) => event.type);

      // Intermediary assistant `message` text is mapped to the reasoning stream,
      // NOT the assistant answer.
      const reasoningDeltas = events.filter(
        (event) => event.type === "content.delta" && event.payload.streamKind === "reasoning_text",
      );
      assert.deepStrictEqual(
        reasoningDeltas.map((event) =>
          event.type === "content.delta" ? event.payload.delta : "",
        ),
        ["Hello", " world"],
      );

      // The actual answer (attempt_completion.result) is streamed as assistant_text.
      const assistantDeltas = events.filter(
        (event) => event.type === "content.delta" && event.payload.streamKind === "assistant_text",
      );
      assert.deepStrictEqual(
        assistantDeltas.map((event) =>
          event.type === "content.delta" ? event.payload.delta : "",
        ),
        ["All done."],
      );

      // The read_file tool produced a started + completed lifecycle pair.
      const toolStarted = events.find((event) => event.type === "item.started");
      assert.isDefined(toolStarted);

      // Final assistant message uses the attempt_completion result, not the reasoning.
      const assistantCompleted = events.find(
        (event) => event.type === "item.completed" && event.payload.itemType === "assistant_message",
      );
      assert.isDefined(assistantCompleted);
      if (assistantCompleted?.type === "item.completed") {
        assert.equal(assistantCompleted.payload.detail, "All done.");
      }

      // Token usage mapped from result stats.
      const usage = events.find((event) => event.type === "thread.token-usage.updated");
      assert.isDefined(usage);
      if (usage?.type === "thread.token-usage.updated") {
        assert.equal(usage.payload.usage.usedTokens, 100);
        assert.equal(usage.payload.usage.inputTokens, 80);
        assert.equal(usage.payload.usage.outputTokens, 20);
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
});
