import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { Command } from "effect/cli";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { browserCommand } from "./browser.ts";

it.layer(NodeServices.layer)("browser setup home", (it) => {
  it.effect.each([
    { envHome: undefined, flagHome: undefined, expected: "/home/treher-test/.t3-treher" },
    { envHome: "/custom/env-home", flagHome: undefined, expected: "/custom/env-home" },
    { envHome: "/custom/env-home", flagHome: "/custom/flag-home", expected: "/custom/flag-home" },
  ])(
    "finds browser tools in $expected when invoked through sudo",
    ({ envHome, flagHome, expected }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const searched: string[] = [];
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.sync(() => {
            const getent = command._tag === "StandardCommand" && command.command === "getent";
            return ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(1),
              exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(getent ? 0 : 1)),
              isRunning: Effect.succeed(false),
              kill: () => Effect.void,
              unref: Effect.succeed(Effect.void),
              stdin: Sink.drain,
              stdout: getent
                ? Stream.make(
                    new TextEncoder().encode(
                      "treher-test:x:1000:1000::/home/treher-test:/bin/sh\n",
                    ),
                  )
                : Stream.empty,
              stderr: Stream.empty,
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
            });
          }),
        );
        yield* Command.runWith(browserCommand, { version: "test" })([
          "setup",
          ...(flagHome ? ["--base-dir", flagHome] : []),
        ]).pipe(
          Effect.provideService(HostProcess.Platform, "linux"),
          Effect.provideService(HostProcess.UserId, 1000),
          Effect.provideService(HostProcess.Environment, {
            SUDO_USER: "treher-test",
            ...(envHome ? { T3CODE_HOME: envHome } : {}),
          }),
          Effect.provideService(HostProcess.HomeDirectory, "/root"),
          Effect.provideService(
            FileSystem.FileSystem,
            FileSystem.FileSystem.of({
              ...fs,
              readFileString: () => Effect.succeed("0"),
              readDirectory: (directory) =>
                Effect.sync(() => {
                  searched.push(directory);
                  return [];
                }),
            }),
          ),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );
        expect(searched).toEqual([path.join(expected, "tools", "chrome-headless-shell")]);
      }),
  );
});
