import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as AcpRegistrySupport from "@t3tools/provider-acp-registry/server/AcpRegistrySupport";
import * as AcpRegistryRuntimeCoordinator from "@t3tools/provider-acp-registry/server/AcpRegistryRuntimeCoordinator";
import * as Option from "effect/Option";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { BobDriver } from "./BobDriver.ts";

const layerTest = Layer.mergeAll(
  NodeServices.layer,
  NodeHttpClient.layerUndici,
  IdAllocator.layer,
  McpProviderSessions.layer,
  TestProviderHost.layer({ runBackgroundWork: false }).pipe(Layer.provide(NodeServices.layer)),
  Layer.succeed(
    ProviderEventLoggers.ProviderEventLoggers,
    ProviderEventLoggers.NoOpProviderEventLoggers,
  ),
);

it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "runs Bob through upstream ACP discovery without scanning or rewriting Bob skills",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-bob-v2-" });
      const mockAgent = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const binaryPath = path.join(cwd, "bob");
      const log = path.join(cwd, "requests.jsonl");
      yield* fs.writeFileString(
        binaryPath,
        `#!/bin/sh\nexec '${process.execPath}' '${mockAgent}'\n`,
      );
      yield* fs.chmod(binaryPath, 0o755);
      yield* fs.makeDirectory(path.join(cwd, ".bob"));
      yield* fs.writeFileString(
        path.join(cwd, ".bob", "custom_modes.yaml"),
        "customModes:\n  - slug: reviewer\n    name: Reviewer\n",
      );
      yield* fs.makeDirectory(path.join(cwd, ".bob", "skills", "local-skill"), { recursive: true });
      yield* fs.writeFileString(
        path.join(cwd, ".bob", "skills", "local-skill", "SKILL.md"),
        "---\nname: local-skill\ndescription: A local Bob skill\n---\nUse this skill.\n",
      );
      const instanceId = ProviderInstanceId.make("bob-test");
      const instance = yield* BobDriver.create({
        instanceId,
        displayName: "Bob test",
        enabled: true,
        config: { ...BobDriver.defaultConfig(), binaryPath },
        environment: [
          { name: "T3_ACP_REQUEST_LOG_PATH", value: log, sensitive: false },
          { name: "T3_ACP_PROMPT_RESPONSE_TEXT", value: "Bob V2 response", sensitive: false },
          { name: "T3_ACP_COMMAND_ADVERTISEMENT_DELAY_MS", value: "0", sensitive: false },
        ],
      });
      const initial = yield* instance.snapshot.getSnapshot;
      assert.equal(initial.driver, "bob");
      assert.equal(initial.supportsTextGeneration, true);
      assert.isFalse(initial.skills.some((skill) => skill.name === "local-skill"));
      assert.isFalse(
        initial.models.some((model) =>
          model.capabilities?.optionDescriptors?.some(
            (option) =>
              option.type === "select" && option.options.some((choice) => choice.id === "reviewer"),
          ),
        ),
      );
      const threadId = ThreadId.make("bob-v2-thread");
      const modelSelection = {
        instanceId,
        model: "default",
        options: [{ id: "_t3/session-mode", value: "code" }],
      } as const;
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd,
      });
      const session = yield* instance.orchestrationAdapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("bob-v2-session"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* session.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      yield* session
        .startTurn({
          appThread: {
            createdBy: "user",
            creationSource: "web",
            id: threadId,
            projectId: ProjectId.make("bob-project"),
            title: "Bob V2",
            providerInstanceId: instanceId,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: providerThread.id,
            lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
          threadId,
          runId: RunId.make("bob-run"),
          runOrdinal: 1,
          providerTurnOrdinal: 1,
          attemptId: RunAttemptId.make("bob-attempt"),
          rootNodeId: NodeId.make("bob-node"),
          providerThread,
          message: {
            createdBy: "user",
            creationSource: "web",
            messageId: MessageId.make("bob-message"),
            text: "Hello Bob $local-skill",
            attachments: [],
          },
          modelSelection,
          runtimePolicy,
        })
        .pipe(Effect.forkScoped);
      const events = yield* session.events.pipe(
        Stream.takeUntil(
          (event) =>
            event.type === "provider_turn.updated" && event.providerTurn.status === "completed",
        ),
        Stream.runCollect,
      );
      assert.isTrue(
        events.some(
          (event) =>
            event.type === "message.updated" && event.message.text.includes("Bob V2 response"),
        ),
      );
      const requests = yield* fs.readFileString(log);
      assert.include(requests, "session/prompt");
      assert.notInclude(requests, "bob-managed");
      assert.include(requests, "$local-skill");
      const prompts = requests
        .split("\n")
        .filter((line) => line.includes('"method":"session/prompt"'));
      assert.equal(prompts.length, 1);
      const coordinator = yield* AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator;
      const commands = Option.getOrThrow(yield* coordinator.getAvailableCommands(instanceId));
      assert.include(
        commands.slashCommands.map((command) => command.name),
        "review",
      );
      const configuration = Option.getOrThrow(yield* coordinator.getLiveConfiguration(instanceId));
      assert.isTrue(
        configuration.configOptions.some(
          (option) => option.type === "select" && option.currentValue === "code",
        ),
      );
    }).pipe(
      Effect.provide(AcpRegistrySupport.layerFromHost.pipe(Layer.provideMerge(layerTest))),
      Effect.scoped,
    ),
);
