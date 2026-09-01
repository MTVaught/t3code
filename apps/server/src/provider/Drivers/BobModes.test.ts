import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { discoverBobModes, mergeBobModes } from "./BobModes.ts";

const writeModes = Effect.fn(function* (file: string, yaml: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(path.dirname(file), { recursive: true });
  yield* fileSystem.writeFileString(file, yaml);
});

it.layer(NodeServices.layer)("discoverBobModes", (it) => {
  it.effect("discovers global and workspace modes and gives the workspace precedence", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temp = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-bob-modes-" });
      const home = path.join(temp, "home");
      const workspace = path.join(temp, "workspace");

      yield* writeModes(
        path.join(home, ".bob", "settings", "custom_modes.yaml"),
        [
          "customModes:",
          "  - slug: probe",
          "    name: Global Probe",
          "    description: From home.",
          "  - slug: reviewer",
          "    name: Reviewer",
          "  - name: missing-slug",
        ].join("\n"),
      );
      yield* writeModes(
        path.join(workspace, ".bob", "custom_modes.yaml"),
        ["customModes:", "  - slug: probe", "    name: Workspace Probe"].join("\n"),
      );
      yield* writeModes(
        path.join(workspace, ".bob", "team", "custom_modes.yaml"),
        ["customModes:", "  - slug: team-writer", "    description: Team docs."].join("\n"),
      );

      const modes = yield* discoverBobModes(workspace, { HOME: home });

      assert.deepEqual(modes, [
        { slug: "probe", name: "Workspace Probe", scope: "workspace" },
        { slug: "reviewer", name: "Reviewer", scope: "global" },
        { slug: "team-writer", name: "team-writer", scope: "workspace", description: "Team docs." },
      ]);
    }),
  );

  it.effect("returns no modes when nothing is configured or the YAML is invalid", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temp = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-bob-modes-" });
      const home = path.join(temp, "home");
      const workspace = path.join(temp, "workspace");
      assert.deepEqual(yield* discoverBobModes(workspace, { HOME: home }), []);

      yield* writeModes(path.join(workspace, ".bob", "custom_modes.yaml"), "customModes: [\n");
      assert.deepEqual(yield* discoverBobModes(workspace, { HOME: home }), []);
    }),
  );
});

it("mergeBobModes keeps built-ins first and never lets a custom slug shadow one", () => {
  const builtIn = [{ slug: "agent", name: "Agent", scope: "built-in" as const }];
  assert.deepEqual(
    mergeBobModes(builtIn, [
      { slug: "agent", name: "Shadow", scope: "global" },
      { slug: "probe", name: "Probe", scope: "workspace" },
    ]),
    [...builtIn, { slug: "probe", name: "Probe", scope: "workspace" }],
  );
});
