// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { BobSettings, ProviderDriverKind, ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";

import { ServerConfig } from "../../config.ts";
import { makeBobAdapter } from "./BobAdapter.ts";

const decodeBobSettings = Schema.decodeSync(BobSettings);
const decodeJsonUnknown = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(dirname, "../../../scripts/acp-mock-agent.ts");

async function makeBobWrapper(input?: {
  readonly environment?: Record<string, string>;
  readonly requestLogPath?: string;
  readonly exitLogPath?: string;
}) {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "bob-acp-mock-"));
  const wrapperPath = NodePath.join(directory, "bob");
  const exports = Object.entries(input?.environment ?? {})
    .map(([name, value]) => `export ${name}=${JSON.stringify(value)}`)
    .join("\n");
  const script = `#!/bin/sh
${exports}
${input?.requestLogPath ? `export T3_ACP_REQUEST_LOG_PATH=${JSON.stringify(input.requestLogPath)}` : ""}
${input?.exitLogPath ? `export T3_ACP_EXIT_LOG_PATH=${JSON.stringify(input.exitLogPath)}` : ""}
exec node ${JSON.stringify(mockAgentPath)}
`;
  await NodeFSP.writeFile(wrapperPath, script, "utf8");
  await NodeFSP.chmod(wrapperPath, 0o755);
  return wrapperPath;
}

const testServices = Layer.merge(
  NodeServices.layer,
  ServerConfig.layerTest(process.cwd(), {
    prefix: "t3code-bob-acp-adapter-test-",
  }).pipe(Layer.provide(NodeServices.layer)),
);

describe("Bob ACP adapter", () => {
  it.effect("starts an ACP session and discovers advertised commands", () =>
    Effect.gen(function* () {
      const wrapper = yield* Effect.promise(() =>
        makeBobWrapper({
          environment: {
            T3_ACP_EMIT_AVAILABLE_COMMANDS: "1",
          },
        }),
      );
      const adapter = yield* makeBobAdapter(
        decodeBobSettings({ enabled: true, binaryPath: wrapper }),
      );
      const threadId = ThreadId.make("bob-acp-thread");
      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("bob"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        providerMode: "architect",
      });
      expect(session.resumeCursor).toEqual({ schemaVersion: 1, sessionId: "mock-session-1" });

      yield* adapter.sendTurn({ threadId, input: "hello" });
      const metadata = yield* adapter.getProjectMetadata!(process.cwd());
      expect(metadata.slashCommands).toEqual([
        {
          name: "review",
          description: "Review the current changes",
          input: { hint: "optional focus" },
        },
      ]);

      yield* adapter.stopSession(threadId);
    }).pipe(Effect.scoped, Effect.provide(testServices)),
  );

  it.effect("reconnects persisted Bob sessions with session/resume", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "bob-acp-resume-")),
      );
      const requestLogPath = NodePath.join(directory, "requests.ndjson");
      const wrapper = yield* Effect.promise(() => makeBobWrapper({ requestLogPath }));
      const adapter = yield* makeBobAdapter(
        decodeBobSettings({ enabled: true, binaryPath: wrapper }),
      );
      const threadId = ThreadId.make("bob-acp-resume-thread");
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("bob"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
        providerMode: "architect",
        resumeCursor: { schemaVersion: 1, sessionId: "mock-session-1" },
      });
      yield* adapter.stopSession(threadId);
      const requests = (yield* Effect.promise(() => NodeFSP.readFile(requestLogPath, "utf8")))
        .trim()
        .split("\n")
        .map((line) => decodeJsonUnknown(line));
      expect(
        requests.some(
          (entry) =>
            typeof entry === "object" &&
            entry !== null &&
            "method" in entry &&
            entry.method === "session/resume",
        ),
      ).toBe(true);
      expect(
        requests.some(
          (entry) =>
            typeof entry === "object" &&
            entry !== null &&
            "method" in entry &&
            entry.method === "session/set_mode",
        ),
      ).toBe(true);
      expect(
        requests.some(
          (entry) =>
            typeof entry === "object" &&
            entry !== null &&
            "method" in entry &&
            entry.method === "session/close",
        ),
      ).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(testServices)),
  );

  it.effect("sends each skill as its own prompt before the message", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "bob-acp-skills-")),
      );
      const home = NodePath.join(directory, "home");
      for (const name of ["deploy", "review"]) {
        const skillDirectory = NodePath.join(home, ".bob", "skills", name);
        yield* Effect.promise(() => NodeFSP.mkdir(skillDirectory, { recursive: true }));
        yield* Effect.promise(() =>
          NodeFSP.writeFile(NodePath.join(skillDirectory, "SKILL.md"), `---\nname: ${name}\n---\n`),
        );
      }
      const requestLogPath = NodePath.join(directory, "requests.ndjson");
      const wrapper = yield* Effect.promise(() => makeBobWrapper({ requestLogPath }));
      const adapter = yield* makeBobAdapter(
        decodeBobSettings({ enabled: true, binaryPath: wrapper }),
        { environment: { ...process.env, HOME: home } },
      );
      const threadId = ThreadId.make("bob-acp-skills");
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("bob"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "$deploy $review ship the $HOME fix" });
      yield* adapter.sendTurn({ threadId, input: "just $deploy" });
      const thread = yield* adapter.readThread(threadId);
      expect(thread.turns).toHaveLength(2);
      yield* adapter.stopSession(threadId);

      const promptTexts = (yield* Effect.promise(() => NodeFSP.readFile(requestLogPath, "utf8")))
        .trim()
        .split("\n")
        .map(
          (line) =>
            decodeJsonUnknown(line) as {
              method?: string;
              params?: { prompt?: Array<{ text?: string }> };
            },
        )
        .filter((entry) => entry.method === "session/prompt")
        .map((entry) => entry.params?.prompt?.map((block) => block.text));
      expect(promptTexts).toEqual([["/deploy"], ["/review ship the $HOME fix"], ["/deploy just"]]);
    }).pipe(Effect.scoped, Effect.provide(testServices)),
  );

  it.effect("returns a failed prompt session to ready state", () =>
    Effect.gen(function* () {
      const wrapper = yield* Effect.promise(() =>
        makeBobWrapper({ environment: { T3_ACP_FAIL_PROMPT: "1" } }),
      );
      const adapter = yield* makeBobAdapter(
        decodeBobSettings({ enabled: true, binaryPath: wrapper }),
      );
      const threadId = ThreadId.make("bob-acp-failed-prompt");
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("bob"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const result = yield* adapter.sendTurn({ threadId, input: "fail" }).pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      expect(
        (yield* adapter.listSessions()).find((session) => session.threadId === threadId)?.status,
      ).toBe("ready");
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.scoped, Effect.provide(testServices)),
  );

  it.effect("keeps sending the turn when Bob rejects the requested mode", () =>
    Effect.gen(function* () {
      const wrapper = yield* Effect.promise(() =>
        makeBobWrapper({ environment: { T3_ACP_FAIL_SET_MODE: "1" } }),
      );
      const adapter = yield* makeBobAdapter(
        decodeBobSettings({ enabled: true, binaryPath: wrapper }),
      );
      const threadId = ThreadId.make("bob-acp-stale-mode");
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("bob"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const result = yield* adapter.sendTurn({
        threadId,
        input: "hello",
        providerMode: "retired-mode",
      });

      expect(result.threadId).toBe(threadId);
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.scoped, Effect.provide(testServices)),
  );

  it.effect("treats cancellation as a hard Bob session boundary", () =>
    Effect.gen(function* () {
      const wrapper = yield* Effect.promise(() =>
        makeBobWrapper({
          environment: {
            T3_ACP_HANG_FIRST_PROMPT_FOREVER: "1",
            T3_ACP_EMIT_BEFORE_HANG: "1",
          },
        }),
      );
      const adapter = yield* makeBobAdapter(
        decodeBobSettings({ enabled: true, binaryPath: wrapper }),
      );
      const threadId = ThreadId.make("bob-acp-cooperative-cancel");
      const promptRunning = yield* Deferred.make<void>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "content.delta"
          ? Deferred.succeed(promptRunning, undefined).pipe(Effect.asVoid)
          : Effect.void,
      ).pipe(Effect.forkChild({ startImmediately: true }));
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("bob"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const firstTurn = yield* adapter
        .sendTurn({ threadId, input: "wait" })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(promptRunning);
      yield* adapter.interruptTurn(threadId);
      yield* Fiber.join(firstTurn);

      expect(yield* adapter.listSessions()).toEqual([]);
      yield* Fiber.interrupt(eventsFiber);
    }).pipe(Effect.scoped, Effect.provide(testServices)),
  );

  it.effect("kills Bob child processes that ignore graceful termination", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "bob-acp-hard-stop-")),
      );
      const childPidPath = NodePath.join(directory, "child.pid");
      const wrapper = yield* Effect.promise(() =>
        makeBobWrapper({
          environment: {
            T3_ACP_HANG_PROMPT_FOREVER: "1",
            T3_ACP_IGNORE_CANCEL: "1",
            T3_ACP_EMIT_BEFORE_HANG: "1",
            T3_ACP_CHILD_PID_PATH: childPidPath,
          },
        }),
      );
      const adapter = yield* makeBobAdapter(
        decodeBobSettings({ enabled: true, binaryPath: wrapper }),
      );
      const threadId = ThreadId.make("bob-acp-hard-stop");
      const promptRunning = yield* Deferred.make<void>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "content.delta"
          ? Deferred.succeed(promptRunning, undefined).pipe(Effect.asVoid)
          : Effect.void,
      ).pipe(Effect.forkChild({ startImmediately: true }));
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("bob"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const turn = yield* adapter
        .sendTurn({ threadId, input: "never settle" })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(promptRunning);
      const childPid = Number(yield* Effect.promise(() => NodeFSP.readFile(childPidPath, "utf8")));
      expect(() => process.kill(childPid, 0)).not.toThrow();

      yield* adapter.interruptTurn(threadId);
      yield* Fiber.await(turn);

      expect(yield* adapter.listSessions()).toEqual([]);
      expect(() => process.kill(childPid, 0)).toThrow();
      yield* Fiber.interrupt(eventsFiber);
    }).pipe(Effect.scoped, Effect.provide(testServices)),
  );
});
