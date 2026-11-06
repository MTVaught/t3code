import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

class LinuxNativePrebuildMissingError extends Schema.TaggedError<LinuxNativePrebuildMissingError>()(
  "LinuxNativePrebuildMissingError",
  { component: Schema.String, prebuildPath: Schema.String },
) {
  override get message(): string {
    return `${this.component} prebuild is missing at ${this.prebuildPath}.`;
  }
}

export const stageLinuxNativePrebuilds = Effect.fn("stageLinuxNativePrebuilds")(function* (input: {
  readonly stageAppDir: string;
  readonly arch: "arm64" | "x64";
  readonly prebuildDirectory: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const prebuilds = {
    nodePty: path.join(input.prebuildDirectory, "pty.node"),
    fff: path.join(input.prebuildDirectory, "libfff_c.so"),
  };

  for (const [component, prebuildPath] of [
    ["node-pty", prebuilds.nodePty],
    ["fff", prebuilds.fff],
  ] as const) {
    if (!(yield* fs.exists(prebuildPath))) {
      return yield* new LinuxNativePrebuildMissingError({ component, prebuildPath });
    }
  }

  const architecture = input.arch === "arm64" ? "arm64" : "x64";
  const nodePtyLink = path.join(input.stageAppDir, "node_modules", "node-pty");
  const nodePtyDir = yield* fs.realPath(nodePtyLink).pipe(Effect.orElseSucceed(() => nodePtyLink));
  const nodePtyBuildDirectory = path.join(nodePtyDir, "build", "Release");
  yield* fs.makeDirectory(nodePtyBuildDirectory, { recursive: true });
  yield* fs.copyFile(prebuilds.nodePty, path.join(nodePtyBuildDirectory, "pty.node"));
  const nodePtyPrebuildDirectory = path.join(nodePtyDir, "prebuilds", `linux-${architecture}`);
  yield* fs.makeDirectory(nodePtyPrebuildDirectory, { recursive: true });
  yield* fs.copyFile(prebuilds.nodePty, path.join(nodePtyPrebuildDirectory, "pty.node"));

  const fffPackageLink = path.join(
    input.stageAppDir,
    "node_modules",
    `@ff-labs/fff-bin-linux-${architecture}-gnu`,
  );
  const fffPackageDir = yield* fs
    .realPath(fffPackageLink)
    .pipe(Effect.orElseSucceed(() => fffPackageLink));
  yield* fs.copyFile(prebuilds.fff, path.join(fffPackageDir, "libfff_c.so"));

  yield* Effect.log(
    `[desktop-artifact] Staged RHEL 8-compatible Linux native prebuilds (${architecture}).`,
  );
});
