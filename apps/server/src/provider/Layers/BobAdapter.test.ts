// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { BobSettings, ProviderDriverKind, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
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
}) {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "bob-acp-mock-"));
  const wrapperPath = NodePath.join(directory, "bob");
  const exports = Object.entries(input?.environment ?? {})
    .map(([name, value]) => `export ${name}=${JSON.stringify(value)}`)
    .join("\n");
  const script = `#!/bin/sh
${exports}
${input?.requestLogPath ? `export T3_ACP_REQUEST_LOG_PATH=${JSON.stringify(input.requestLogPath)}` : ""}
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
});
