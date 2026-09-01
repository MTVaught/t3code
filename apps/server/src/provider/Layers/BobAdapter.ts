/** IBM Bob Shell provider adapter implemented through Agent Client Protocol. */
import {
  type BobSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProviderMode,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { ServerConfig } from "../../config.ts";
import { ProviderAdapterProcessError } from "../Errors.ts";
import { makeAcpNativeLoggerFactory } from "../acp/AcpNativeLogging.ts";
import { makeBobAcpRuntime } from "../acp/BobAcpSupport.ts";
import { discoverBobSkills } from "../Drivers/BobSkills.ts";
import { makeBasicAcpAdapter } from "./BasicAcpAdapter.ts";
import type { BobAdapterShape } from "../Services/BobAdapter.ts";
import type { EventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = ProviderDriverKind.make("bob");

export const BOB_BUILT_IN_MODES: ReadonlyArray<ServerProviderMode> = [
  { slug: "agent", name: "Agent", scope: "built-in" },
  { slug: "ask", name: "Ask", scope: "built-in" },
  { slug: "plan", name: "Plan", scope: "built-in" },
];

export interface BobAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly instanceId?: ProviderInstanceId;
  /** Native ACP request/protocol log, shared with the other providers. */
  readonly nativeEventLogger?: EventNdjsonLogger;
}

export const makeBobAdapter = Effect.fn("makeBobAdapter")(function* (
  settings: BobSettings,
  options?: BobAdapterLiveOptions,
) {
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const instanceId = options?.instanceId ?? ProviderInstanceId.make("bob");
  const makeAcpNativeLoggers = yield* makeAcpNativeLoggerFactory();

  const adapter = yield* makeBasicAcpAdapter({
    provider: PROVIDER,
    instanceId,
    displayName: "Bob",
    builtInModes: BOB_BUILT_IN_MODES,
    makeRuntime: ({ threadId, cwd, resumeSessionId, mcpServers, scope }) =>
      makeBobAcpRuntime({
        bobSettings: settings,
        ...(options?.environment ? { environment: options.environment } : {}),
        childProcessSpawner,
        cwd,
        ...(resumeSessionId ? { resumeSessionId } : {}),
        ...(mcpServers ? { mcpServers } : {}),
        clientInfo: { name: "t3-code", version: "0.0.0" },
        ...makeAcpNativeLoggers({
          nativeEventLogger: options?.nativeEventLogger,
          provider: PROVIDER,
          threadId,
        }),
      }).pipe(
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(Scope.Scope, scope),
        Effect.mapError(
          (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId,
              detail: cause.message,
              cause,
            }),
        ),
      ),
  }).pipe(
    Effect.provideService(FileSystem.FileSystem, yield* FileSystem.FileSystem),
    Effect.provideService(Path.Path, yield* Path.Path),
    Effect.provideService(ServerConfig, yield* ServerConfig),
    Effect.provideService(Crypto.Crypto, crypto),
  );

  return {
    ...adapter,
    getProjectMetadata: (cwd) =>
      Effect.all({
        metadata: adapter.getProjectMetadata!(cwd),
        skills: discoverBobSkills(cwd, options?.environment).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        ),
      }).pipe(Effect.map(({ metadata, skills }) => ({ ...metadata, skills }))),
  } satisfies BobAdapterShape;
});
