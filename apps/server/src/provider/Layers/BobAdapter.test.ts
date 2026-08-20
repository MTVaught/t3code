import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
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

import { buildBobTurnArgs, makeBobAdapter } from "./BobAdapter.ts";
import { attachmentRelativePath, createAttachmentId } from "../../attachmentStore.ts";

const decodeBobSettings = Schema.decodeSync(BobSettings);
const TASK_ID = "aec50d67403c4d08a624596bbd18a339";

function makeHandle(input: { stdout: string; stderr?: string; exitCode?: number }) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(input.exitCode ?? 0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.encodeText(Stream.make(input.stdout)),
    stderr: Stream.encodeText(Stream.make(input.stderr ?? "")),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function streamJson(events: ReadonlyArray<Record<string, unknown>>) {
  return `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

const successStream = streamJson([
  { type: "message", role: "user", content: "hi" },
  { type: "message", role: "assistant", content: "Thinking", isReasoning: true },
  { type: "message", role: "assistant", content: "[using tool undefined: ...]\n" },
  { type: "tool_use", tool_name: "read_file", tool_id: "tool-1", parameters: { path: "a.ts" } },
  { type: "tool_result", tool_id: "tool-1", status: "success", output: "contents" },
  { type: "message", role: "assistant", content: "Done" },
  {
    type: "result",
    status: "success",
    stats: { task_id: TASK_ID, duration_ms: 20, session_costs: 0.01, tool_calls: 1 },
  },
]);

it.layer(NodeServices.layer)("BobAdapter", (it) => {
  it("builds Bob 2 args and intersects runtime mode with the instance ceiling", () => {
    assert.deepStrictEqual(
      buildBobTurnArgs({
        prompt: "hi",
        workspace: "/workspace",
        mode: "agent",
        runtimeMode: "full-access",
        toolAccessCeiling: "full",
        resumeTaskId: TASK_ID,
        teamId: "team",
        taskCostThresholdBobcoins: 1.5,
        maxTurns: 4,
      }),
      [
        "run",
        "--format",
        "stream-json",
        "--workspace",
        "/workspace",
        "--mode",
        "agent",
        "--resume",
        TASK_ID,
        "--team-id",
        "team",
        "--max-cost",
        "1.5",
        "--max-turns",
        "4",
        "hi",
      ],
    );

    const supervised = buildBobTurnArgs({
      prompt: "hi",
      workspace: "/workspace",
      mode: "plan",
      runtimeMode: "approval-required",
      toolAccessCeiling: "full",
    });
    assert.include(supervised, "--disable-mcp");
    assert.include(supervised, "--disable-subagents");
    assert.include(supervised, "edit,execute,mcp,subagent,browser,mode");

    const ceiling = buildBobTurnArgs({
      prompt: "hi",
      workspace: "/workspace",
      mode: "agent",
      runtimeMode: "full-access",
      toolAccessCeiling: "edits",
    });
    assert.include(ceiling, "execute,mcp,subagent,browser,mode");
  });

  it.effect("streams Bob 2 deltas and persists its terminal task cursor in the adapter", () =>
    Effect.gen(function* () {
      const spawnedArgs: Array<ReadonlyArray<string>> = [];
      const spawnedStdin: Array<unknown> = [];
      const fakeSpawner = ChildProcessSpawner.make((command) => {
        spawnedArgs.push((command as { readonly args: ReadonlyArray<string> }).args);
        spawnedStdin.push(
          (command as { readonly options: { readonly stdin?: unknown } }).options.stdin,
        );
        return Effect.succeed(makeHandle({ stdout: successStream }));
      });
      const adapter = yield* makeBobAdapter(
        decodeBobSettings({ enabled: true, toolAccessCeiling: "full" }),
        { instanceId: ProviderInstanceId.make("bob") },
      ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fakeSpawner));
      const events: Array<ProviderRuntimeEvent> = [];
      const done = yield* Deferred.make<void>();
      yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => events.push(event)).pipe(
          Effect.andThen(
            event.type === "turn.completed" ? Deferred.succeed(done, undefined) : Effect.void,
          ),
        ),
      ).pipe(Effect.forkScoped);

      const threadId = ThreadId.make("bob2-stream");
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("bob"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const started = yield* adapter.sendTurn({ threadId, input: "hi" });
      assert.equal(started.resumeCursor, undefined);
      yield* Deferred.await(done);

      assert.deepStrictEqual(
        events
          .filter((event) => event.type === "content.delta")
          .map((event) => (event.type === "content.delta" ? event.payload.streamKind : "")),
        ["reasoning_text", "assistant_text"],
      );
      assert.notInclude(
        events
          .filter((event) => event.type === "content.delta")
          .map((event) => (event.type === "content.delta" ? event.payload.delta : ""))
          .join(""),
        "using tool undefined",
      );
      assert.include(
        events.map((event) => event.type),
        "item.started",
      );
      assert.include(
        events.map((event) => event.type),
        "item.completed",
      );
      const completedTool = events.find((event) => event.type === "item.completed");
      assert.equal(
        completedTool?.type === "item.completed" ? completedTool.payload.title : null,
        "read_file",
      );
      assert.deepInclude(
        completedTool?.type === "item.completed" ? completedTool.payload.data : {},
        { toolName: "read_file", input: { path: "a.ts" }, result: "contents" },
      );
      const [session] = yield* adapter.listSessions();
      assert.equal((session?.resumeCursor as { taskId?: string } | undefined)?.taskId, TASK_ID);
      assert.deepStrictEqual(spawnedArgs[0]?.slice(0, 3), ["run", "--format", "stream-json"]);
      assert.notInclude(spawnedArgs[0] ?? [], "-m");
      assert.isTrue(Stream.isStream(spawnedStdin[0]));
    }),
  );

  it.effect("gives a duplicate stream error precedence over a success result", () =>
    Effect.gen(function* () {
      const output = streamJson([
        { type: "error", severity: "error", message: "Maximum turns limit reached: 1" },
        { type: "error", severity: "error", message: "Maximum turns limit reached: 1" },
        { type: "result", status: "success", stats: { task_id: TASK_ID } },
      ]);
      const fakeSpawner = ChildProcessSpawner.make(() =>
        Effect.succeed(makeHandle({ stdout: output })),
      );
      const adapter = yield* makeBobAdapter(decodeBobSettings({ enabled: true })).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fakeSpawner),
      );
      const completed = yield* Deferred.make<ProviderRuntimeEvent>();
      yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "turn.completed" ? Deferred.succeed(completed, event) : Effect.void,
      ).pipe(Effect.forkScoped);
      const threadId = ThreadId.make("bob2-limit");
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("bob"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "hi" });
      const event = yield* Deferred.await(completed);
      assert.equal(event.type === "turn.completed" ? event.payload.state : undefined, "failed");
      assert.include(
        event.type === "turn.completed" ? (event.payload.errorMessage ?? "") : "",
        "Maximum turns",
      );
    }),
  );

  it.effect("reports a successful Bob-initiated mode switch", () =>
    Effect.gen(function* () {
      const output = streamJson([
        {
          type: "tool_use",
          tool_name: "switch_mode",
          tool_id: "mode-1",
          parameters: { mode_slug: "reviewer" },
        },
        { type: "tool_result", tool_id: "mode-1", status: "success", output: "Switched" },
        { type: "result", status: "success", stats: { task_id: TASK_ID } },
      ]);
      const fakeSpawner = ChildProcessSpawner.make(() =>
        Effect.succeed(makeHandle({ stdout: output })),
      );
      const adapter = yield* makeBobAdapter(decodeBobSettings({ enabled: true })).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fakeSpawner),
      );
      const modeChanged = yield* Deferred.make<ProviderRuntimeEvent>();
      yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "thread.metadata.updated" &&
        event.payload.metadata?.providerMode === "reviewer"
          ? Deferred.succeed(modeChanged, event)
          : Effect.void,
      ).pipe(Effect.forkScoped);
      const threadId = ThreadId.make("bob2-mode-switch");
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("bob"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "review this" });
      const event = yield* Deferred.await(modeChanged);
      assert.equal(
        event.type === "thread.metadata.updated" ? event.payload.metadata?.providerMode : undefined,
        "reviewer",
      );
    }),
  );

  it.effect("classifies a missing resume task emitted only on stderr", () =>
    Effect.gen(function* () {
      const fakeSpawner = ChildProcessSpawner.make(() =>
        Effect.succeed(
          makeHandle({
            stdout: "",
            stderr: "Unexpected error: No task found with id '00000000000000000000000000000000'.",
            exitCode: 1,
          }),
        ),
      );
      const adapter = yield* makeBobAdapter(decodeBobSettings({ enabled: true })).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fakeSpawner),
      );
      const completed = yield* Deferred.make<ProviderRuntimeEvent>();
      yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "turn.completed" ? Deferred.succeed(completed, event) : Effect.void,
      ).pipe(Effect.forkScoped);
      const threadId = ThreadId.make("bob2-missing-task");
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("bob"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        resumeCursor: { version: 1, taskId: "00000000000000000000000000000000" },
      });
      yield* adapter.sendTurn({ threadId, input: "hi" });
      const event = yield* Deferred.await(completed);
      assert.include(
        event.type === "turn.completed" ? (event.payload.errorMessage ?? "") : "",
        "missing-task",
      );
    }),
  );

  it.effect("requires an explicit reset for malformed Bob 2 continuation state", () =>
    Effect.gen(function* () {
      const spawnCount: Array<number> = [];
      const adapter = yield* makeBobAdapter(decodeBobSettings({ enabled: true })).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => {
            spawnCount.push(1);
            return Effect.succeed(makeHandle({ stdout: successStream }));
          }),
        ),
      );
      const threadId = ThreadId.make("bob2-invalid-cursor");
      yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "full-access",
        resumeCursor: { version: 1, taskId: "not-a-bob-task" },
      });

      const error = yield* Effect.flip(adapter.sendTurn({ threadId, input: "hi" }));
      assert.include(error.message, "Start a new Bob context");
      assert.lengthOf(spawnCount, 0);

      const completed = yield* Deferred.make<void>();
      yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "turn.completed" ? Deferred.succeed(completed, undefined) : Effect.void,
      ).pipe(Effect.forkScoped);
      yield* adapter.resetContext!(threadId);
      yield* adapter.sendTurn({ threadId, input: "hi" });
      yield* Deferred.await(completed);
      assert.lengthOf(spawnCount, 1);
    }),
  );

  it.effect("does not accept a resumed success result without a current task id", () =>
    Effect.gen(function* () {
      const output = streamJson([{ type: "result", status: "success", stats: {} }]);
      const adapter = yield* makeBobAdapter(decodeBobSettings({ enabled: true })).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.succeed(makeHandle({ stdout: output }))),
        ),
      );
      const completed = yield* Deferred.make<ProviderRuntimeEvent>();
      yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "turn.completed" ? Deferred.succeed(completed, event) : Effect.void,
      ).pipe(Effect.forkScoped);
      const threadId = ThreadId.make("bob2-current-task-id");
      yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "full-access",
        resumeCursor: { version: 1, taskId: TASK_ID },
      });
      yield* adapter.sendTurn({ threadId, input: "continue" });

      const event = yield* Deferred.await(completed);
      assert.equal(event.type === "turn.completed" ? event.payload.state : undefined, "failed");
      const [session] = yield* adapter.listSessions();
      assert.equal((session?.resumeCursor as { taskId?: string } | undefined)?.taskId, TASK_ID);
    }),
  );

  it.effect("passes slash text literally and defaults Bob mode to agent", () =>
    Effect.gen(function* () {
      const spawnedArgs: Array<ReadonlyArray<string>> = [];
      const adapter = yield* makeBobAdapter(decodeBobSettings({ enabled: true })).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make((command) => {
            spawnedArgs.push((command as { readonly args: ReadonlyArray<string> }).args);
            return Effect.succeed(makeHandle({ stdout: successStream }));
          }),
        ),
      );
      const threadId = ThreadId.make("bob2-literal-command");
      const completed = yield* Deferred.make<void>();
      yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "turn.completed" ? Deferred.succeed(completed, undefined) : Effect.void,
      ).pipe(Effect.forkScoped);
      yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
      yield* adapter.sendTurn({ threadId, input: "/review VALUE77" });
      yield* Deferred.await(completed);

      assert.include(spawnedArgs[0] ?? [], "agent");
      assert.equal(spawnedArgs[0]?.at(-1), "/review VALUE77");
    }),
  );

  it.effect("uses a resumed Bob task's stored mode and repairs stale thread metadata", () =>
    Effect.gen(function* () {
      const spawnedArgs: Array<ReadonlyArray<string>> = [];
      const adapter = yield* makeBobAdapter(decodeBobSettings({ enabled: true })).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make((command) => {
            spawnedArgs.push((command as { readonly args: ReadonlyArray<string> }).args);
            return Effect.succeed(makeHandle({ stdout: successStream }));
          }),
        ),
      );
      const threadId = ThreadId.make("bob2-mode-change");
      const completed = yield* Deferred.make<void>();
      const repairedMode = yield* Deferred.make<string>();
      yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "turn.completed"
          ? Deferred.succeed(completed, undefined)
          : event.type === "thread.metadata.updated" &&
              typeof event.payload.metadata?.providerMode === "string"
            ? Deferred.succeed(repairedMode, event.payload.metadata.providerMode)
            : Effect.void,
      ).pipe(Effect.forkScoped);
      yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "full-access",
        resumeCursor: { version: 1, taskId: TASK_ID, mode: "agent" },
      });
      yield* adapter.sendTurn({
        threadId,
        input: "continue the existing task",
        providerMode: "t3-mode-probe",
      });
      yield* Deferred.await(completed);

      assert.equal(yield* Deferred.await(repairedMode), "agent");
      assert.include(spawnedArgs[0] ?? [], "--resume");
      assert.include(spawnedArgs[0] ?? [], TASK_ID);
      assert.include(spawnedArgs[0] ?? [], "agent");
      assert.notInclude(spawnedArgs[0] ?? [], "t3-mode-probe");
      const [session] = yield* adapter.listSessions();
      assert.equal((session?.resumeCursor as { mode?: string } | undefined)?.mode, "agent");
    }),
  );

  it.effect("publishes the resolved initial Bob mode as thread metadata", () =>
    Effect.gen(function* () {
      const adapter = yield* makeBobAdapter(decodeBobSettings({ enabled: true })).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.succeed(makeHandle({ stdout: successStream }))),
        ),
      );
      const modeUpdated = yield* Deferred.make<string>();
      yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "thread.metadata.updated" &&
        typeof event.payload.metadata?.providerMode === "string"
          ? Deferred.succeed(modeUpdated, event.payload.metadata.providerMode)
          : Effect.void,
      ).pipe(Effect.forkScoped);
      const threadId = ThreadId.make("bob2-initial-mode");
      yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
      yield* adapter.sendTurn({ threadId, input: "hi" });

      assert.equal(yield* Deferred.await(modeUpdated), "agent");
    }),
  );

  it.effect("drains Bob after SIGINT and keeps the T3 turn interrupted", () =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<string>();
      const killOptions: Array<unknown> = [];
      const fakeSpawner = ChildProcessSpawner.make(() =>
        Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(2),
            exitCode: Deferred.await(release).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
            isRunning: Effect.succeed(true),
            kill: (options) =>
              Effect.sync(() => killOptions.push(options)).pipe(
                Effect.andThen(
                  Deferred.succeed(
                    release,
                    streamJson([
                      {
                        type: "tool_use",
                        tool_name: "execute_command",
                        tool_id: "cancelled-tool",
                        parameters: {},
                      },
                      {
                        type: "result",
                        status: "success",
                        stats: { task_id: TASK_ID, session_costs: 0.02 },
                      },
                    ]),
                  ),
                ),
                Effect.asVoid,
              ),
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.encodeText(Stream.fromEffect(Deferred.await(release))),
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          }),
        ),
      );
      const adapter = yield* makeBobAdapter(decodeBobSettings({ enabled: true })).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fakeSpawner),
      );
      const completed = yield* Deferred.make<ProviderRuntimeEvent>();
      yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "turn.completed" ? Deferred.succeed(completed, event) : Effect.void,
      ).pipe(Effect.forkScoped);

      const threadId = ThreadId.make("bob2-interrupt");
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      yield* adapter.sendTurn({ threadId, input: "run a long command" });
      yield* Effect.yieldNow;
      yield* adapter.interruptTurn(threadId);
      const terminal = yield* Deferred.await(completed);

      assert.deepStrictEqual(killOptions, [{ killSignal: "SIGINT", forceKillAfter: "2 seconds" }]);
      assert.equal(terminal.type, "turn.completed");
      if (terminal.type === "turn.completed") assert.equal(terminal.payload.state, "interrupted");
      const [session] = yield* adapter.listSessions();
      assert.equal((session?.resumeCursor as { taskId?: string } | undefined)?.taskId, TASK_ID);
    }),
  );

  it.effect("stages image attachments inside the workspace and cleans them before completion", () =>
    Effect.gen(function* () {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-bob-attachment-"));
      const workspace = NodePath.join(root, "workspace");
      const attachmentsDir = NodePath.join(root, "attachments");
      NodeFS.mkdirSync(workspace, { recursive: true });
      NodeFS.mkdirSync(attachmentsDir, { recursive: true });
      const staleDirectory = NodePath.join(workspace, ".t3-bob-attachments", "stale-turn");
      NodeFS.mkdirSync(staleDirectory, { recursive: true });
      NodeFS.writeFileSync(NodePath.join(staleDirectory, "old.png"), "old");
      const threadId = ThreadId.make("bob-attachment");
      const id = createAttachmentId(threadId)!;
      const attachment = {
        id,
        type: "image" as const,
        name: "chart space",
        mimeType: "image/png",
        sizeBytes: 3,
      };
      NodeFS.writeFileSync(
        NodePath.join(attachmentsDir, attachmentRelativePath(attachment)),
        "png",
      );
      let stagedPath: string | undefined;
      const fakeSpawner = ChildProcessSpawner.make((command) => {
        const prompt = (command as { readonly args: ReadonlyArray<string> }).args.at(-1)!;
        const reference = /@(\.t3-bob-attachments\/[^\s]+)/.exec(prompt)?.[1];
        assert.isDefined(reference);
        stagedPath = NodePath.join(workspace, reference!);
        assert.equal(NodeFS.existsSync(stagedPath), true);
        return Effect.succeed(makeHandle({ stdout: successStream }));
      });
      const adapter = yield* makeBobAdapter(decodeBobSettings({ enabled: true }), {
        attachmentsDir,
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fakeSpawner));
      const completed = yield* Deferred.make<void>();
      yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "turn.completed" ? Deferred.succeed(completed, undefined) : Effect.void,
      ).pipe(Effect.forkScoped);
      yield* adapter.startSession({ threadId, cwd: workspace, runtimeMode: "full-access" });
      assert.equal(NodeFS.existsSync(staleDirectory), false);
      yield* adapter.sendTurn({ threadId, input: "inspect", attachments: [attachment] });
      yield* Deferred.await(completed);
      assert.equal(stagedPath?.endsWith(".png"), true);
      assert.equal(stagedPath ? NodeFS.existsSync(stagedPath) : true, false);
      NodeFS.rmSync(root, { recursive: true, force: true });
    }),
  );

  it.effect("rejects invalid or missing attachment sources without spawning Bob", () =>
    Effect.gen(function* () {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-bob-invalid-attachment-"));
      const workspace = NodePath.join(root, "workspace");
      const attachmentsDir = NodePath.join(root, "attachments");
      NodeFS.mkdirSync(workspace, { recursive: true });
      NodeFS.mkdirSync(attachmentsDir, { recursive: true });
      let spawnCount = 0;
      const adapter = yield* makeBobAdapter(decodeBobSettings({ enabled: true }), {
        attachmentsDir,
      }).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => {
            spawnCount += 1;
            return Effect.succeed(makeHandle({ stdout: successStream }));
          }),
        ),
      );
      const threadId = ThreadId.make("bob-invalid-attachment");
      yield* adapter.startSession({ threadId, cwd: workspace, runtimeMode: "full-access" });
      const baseAttachment = {
        type: "image" as const,
        name: "image.png",
        mimeType: "image/png",
        sizeBytes: 3,
      };

      yield* Effect.flip(
        adapter.sendTurn({
          threadId,
          input: "inspect",
          attachments: [{ ...baseAttachment, id: "../../outside" }],
        }),
      );
      yield* Effect.flip(
        adapter.sendTurn({
          threadId,
          input: "inspect",
          attachments: [{ ...baseAttachment, id: createAttachmentId(threadId)! }],
        }),
      );

      assert.equal(spawnCount, 0);
      const stagingRoot = NodePath.join(workspace, ".t3-bob-attachments");
      assert.deepStrictEqual(NodeFS.readdirSync(stagingRoot), []);
      NodeFS.rmSync(root, { recursive: true, force: true });
    }),
  );

  it.effect("projects Bob subagent lifecycle summaries without inventing live child progress", () =>
    Effect.gen(function* () {
      const output = streamJson([
        {
          type: "tool_use",
          tool_name: "spawn_subagent",
          tool_id: "child-1",
          parameters: { description: "Review the decoder" },
        },
        {
          type: "tool_result",
          tool_id: "child-1",
          status: "success",
          output: "<task_result>Decoder looks sound.</task_result>",
        },
        { type: "result", status: "success", stats: { task_id: TASK_ID } },
      ]);
      const adapter = yield* makeBobAdapter(decodeBobSettings({ enabled: true })).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.succeed(makeHandle({ stdout: output }))),
        ),
      );
      const events: Array<ProviderRuntimeEvent> = [];
      const completed = yield* Deferred.make<void>();
      yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => events.push(event)).pipe(
          Effect.andThen(
            event.type === "turn.completed" ? Deferred.succeed(completed, undefined) : Effect.void,
          ),
        ),
      ).pipe(Effect.forkScoped);
      const threadId = ThreadId.make("bob-subagent");
      yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
      yield* adapter.sendTurn({ threadId, input: "delegate" });
      yield* Deferred.await(completed);
      const started = events.find((event) => event.type === "task.started");
      const finished = events.find((event) => event.type === "task.completed");
      assert.equal(started?.type === "task.started" ? started.payload.title : undefined, undefined);
      assert.equal(
        started?.type === "task.started" ? started.payload.description : undefined,
        "Review the decoder",
      );
      assert.equal(
        finished?.type === "task.completed" ? finished.payload.summary : undefined,
        "Decoder looks sound.",
      );
      assert.notInclude(
        events.map((event) => event.type),
        "task.progress",
      );
    }),
  );

  it.effect("clears a Bob resume cursor and emits a persistence signal", () =>
    Effect.gen(function* () {
      const adapter = yield* makeBobAdapter(decodeBobSettings({ enabled: true })).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.succeed(makeHandle({ stdout: successStream }))),
        ),
      );
      const configured = yield* Deferred.make<void>();
      const completed = yield* Deferred.make<void>();
      yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "session.configured"
          ? Deferred.succeed(configured, undefined)
          : event.type === "turn.completed"
            ? Deferred.succeed(completed, undefined)
            : Effect.void,
      ).pipe(Effect.forkScoped);
      const threadId = ThreadId.make("bob-reset");
      yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
      yield* adapter.sendTurn({ threadId, input: "hi" });
      yield* Deferred.await(completed);
      const reset = yield* adapter.resetContext!(threadId);
      yield* Deferred.await(configured);
      assert.equal(reset.resumeCursor, undefined);
    }),
  );
});
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
