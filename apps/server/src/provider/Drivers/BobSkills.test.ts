import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { discoverBobSkills, splitBobSkillPreludes } from "./BobSkills.ts";

const writeSkill = Effect.fn(function* (root: string, directory: string, description: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const skillDirectory = path.join(root, directory);
  yield* fileSystem.makeDirectory(skillDirectory, { recursive: true });
  yield* fileSystem.writeFileString(
    path.join(skillDirectory, "SKILL.md"),
    ["---", `name: ${directory}`, `description: ${description}`, "---"].join("\n"),
  );
});

it.layer(NodeServices.layer)("discoverBobSkills", (it) => {
  it.effect("discovers user and project skills and gives the project precedence", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temp = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-bob-skills-" });
      const home = path.join(temp, "home");
      const workspace = path.join(temp, "workspace");

      yield* writeSkill(path.join(home, ".bob", "skills"), "deploy", "User deploy.");
      yield* writeSkill(path.join(workspace, ".bob", "skills"), "deploy", "Project deploy.");
      yield* writeSkill(path.join(workspace, ".bob", "skills"), "review", "Review changes.");

      const skills = yield* discoverBobSkills(workspace, { HOME: home });

      assert.deepEqual(
        skills.map(({ name, scope, description }) => ({ name, scope, description })),
        [
          { name: "deploy", scope: "project", description: "Project deploy." },
          { name: "review", scope: "project", description: "Review changes." },
        ],
      );
    }),
  );
});

it("splitBobSkillPreludes peels known skills into their own prompts", () => {
  const skills = [{ name: "deploy" }, { name: "review" }];
  assert.deepEqual(splitBobSkillPreludes("$deploy $review ship it $deploy", skills), {
    preludes: ["$deploy", "$review"],
    text: "ship it",
  });
  assert.deepEqual(splitBobSkillPreludes("costs $HOME dollars", skills), {
    preludes: [],
    text: "costs $HOME dollars",
  });
  assert.deepEqual(splitBobSkillPreludes("$review", skills), { preludes: ["$review"], text: "" });
});
