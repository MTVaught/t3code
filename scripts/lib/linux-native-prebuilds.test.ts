import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { stageLinuxNativePrebuilds } from "./linux-native-prebuilds.ts";

it.layer(NodeServices.layer)("RHEL 8 native staging", (it) => {
  it.effect("replaces both terminal load paths and the fff binary through package symlinks", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const app = path.join(root, "app");
      const prebuilds = path.join(root, "prebuilds");
      const terminal = path.join(root, "pty-package");
      const finder = path.join(root, "fff-package");
      for (const directory of [
        prebuilds,
        terminal,
        finder,
        path.join(app, "node_modules/@ff-labs"),
      ]) {
        yield* fs.makeDirectory(directory, { recursive: true });
      }
      yield* fs.symlink(terminal, path.join(app, "node_modules/node-pty"));
      yield* fs.symlink(finder, path.join(app, "node_modules/@ff-labs/fff-bin-linux-x64-gnu"));
      yield* fs.writeFileString(path.join(prebuilds, "pty.node"), "compatible-terminal");
      yield* fs.writeFileString(path.join(prebuilds, "libfff_c.so"), "compatible-finder");
      yield* stageLinuxNativePrebuilds({
        stageAppDir: app,
        arch: "x64",
        prebuildDirectory: prebuilds,
      });
      assert.equal(
        yield* fs.readFileString(path.join(terminal, "build/Release/pty.node")),
        "compatible-terminal",
      );
      assert.equal(
        yield* fs.readFileString(path.join(terminal, "prebuilds/linux-x64/pty.node")),
        "compatible-terminal",
      );
      assert.equal(yield* fs.readFileString(path.join(finder, "libfff_c.so")), "compatible-finder");
    }),
  );
});
