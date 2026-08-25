import type { BobSettings } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";

import { resolveBobBinary } from "../Drivers/BobEnvironment.ts";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

export interface BobAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "continuationMethod" | "modeMethod" | "spawn"
> {
  readonly bobSettings: Pick<BobSettings, "binaryPath">;
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly environment?: NodeJS.ProcessEnv;
  readonly disableMcp?: boolean;
  readonly disableSubagents?: boolean;
}

export function buildBobAcpSpawnInput(input: {
  readonly bobSettings: Pick<BobSettings, "binaryPath">;
  readonly cwd: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly disableMcp?: boolean;
  readonly disableSubagents?: boolean;
}): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: resolveBobBinary(input.bobSettings),
    args: [
      "acp",
      ...(input.disableMcp ? ["--disable-mcp"] : []),
      ...(input.disableSubagents ? ["--disable-subagents"] : []),
    ],
    cwd: input.cwd,
    ...(input.environment ? { env: input.environment } : {}),
  };
}

export const makeBobAcpRuntime = (
  input: BobAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildBobAcpSpawnInput(input),
        authMethodId: "sso",
        continuationMethod: "resume",
        modeMethod: "set_mode",
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(Effect.provide(context));
  });
