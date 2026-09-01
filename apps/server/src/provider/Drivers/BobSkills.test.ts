import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { discoverBobSkills, selectInvocableBobSkills, splitBobSkillPreludes } from "./BobSkills.ts";

const writeSkill = Effect.fn(function* (
  root: string,
  directory: string,
  description: string,
  extraFrontmatter: ReadonlyArray<string> = [],
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const skillDirectory = path.join(root, directory);
  yield* fileSystem.makeDirectory(skillDirectory, { recursive: true });
  yield* fileSystem.writeFileString(
    path.join(skillDirectory, "SKILL.md"),
    ["---", `name: ${directory}`, `description: ${description}`, ...extraFrontmatter, "---"].join(
      "\n",
    ),
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
      yield* writeSkill(path.join(workspace, ".bob", "skills"), "hidden", "Model only.", [
        "metadata:",
        "  user-invocable: false",
      ]);
      yield* writeSkill(path.join(workspace, ".bob", "skills"), "hidden-top", "Model only.", [
        "user-invocable: false",
      ]);
      yield* writeSkill(path.join(workspace, ".bob", "skills"), "locked", "User only.", [
        "metadata:",
        "  disable-model-invocation: true",
      ]);

      const skills = yield* discoverBobSkills(workspace, { HOME: home });

      assert.deepEqual(
        skills.map(({ name, scope, description }) => ({ name, scope, description })),
        [
          { name: "deploy", scope: "project", description: "Project deploy." },
          { name: "locked", scope: "project", description: "User only." },
          { name: "review", scope: "project", description: "Review changes." },
        ],
      );
    }),
  );
});

it("splitBobSkillPreludes turns known skills into /name prompts with the message as argument", () => {
  const skills = [{ name: "deploy" }, { name: "review" }];
  assert.deepEqual(splitBobSkillPreludes("$review $deploy ship it $deploy", skills), {
    preludes: ["/review"],
    text: "/deploy ship it",
  });
  assert.deepEqual(splitBobSkillPreludes("please $deploy now", skills), {
    preludes: [],
    text: "/deploy please now",
  });
  assert.deepEqual(splitBobSkillPreludes("costs $HOME dollars", skills), {
    preludes: [],
    text: "costs $HOME dollars",
  });
  assert.deepEqual(splitBobSkillPreludes("$review", skills), { preludes: [], text: "/review" });
});

it("selectInvocableBobSkills defers to Bob's catalog once a session reports one", () => {
  const deploy = { name: "deploy", path: "/a", enabled: true };
  const review = { name: "review", path: "/b", enabled: true };
  const discovered = [deploy, review];
  assert.deepEqual(selectInvocableBobSkills(discovered, []), discovered);
  assert.deepEqual(
    selectInvocableBobSkills(discovered, [{ name: "review" }, { name: "mcp:prompt" }]),
    [review],
  );
});
