// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { discoverBobModes } from "./BobModes.ts";

it.layer(NodeServices.layer)("BobModes", (it) => {
  it.effect("merges built-in, global, and workspace modes by slug", () =>
    Effect.gen(function* () {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-bob-modes-"));
      const home = NodePath.join(root, "home");
      const workspace = NodePath.join(root, "workspace");
      NodeFS.mkdirSync(NodePath.join(home, ".bob", "settings"), { recursive: true });
      NodeFS.mkdirSync(NodePath.join(workspace, ".bob"), { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(home, ".bob", "settings", "custom_modes.yaml"),
        "customModes:\n  - slug: reviewer\n    name: Reviewer\n  - slug: ask\n    name: Global Ask\n",
      );
      NodeFS.writeFileSync(
        NodePath.join(workspace, ".bob", "custom_modes.yaml"),
        "customModes:\n  - slug: reviewer\n    name: Workspace Reviewer\n    description: Reviews this workspace.\n",
      );
      const modes = yield* discoverBobModes(workspace, { HOME: home });
      assert.deepStrictEqual(modes, [
        {
          slug: "agent",
          name: "Agent",
          description: "Complete tasks with Bob's available tools.",
          scope: "built-in",
        },
        { slug: "ask", name: "Global Ask", scope: "global" },
        {
          slug: "plan",
          name: "Plan",
          description: "Plan an approach before implementation.",
          scope: "built-in",
        },
        {
          slug: "reviewer",
          name: "Workspace Reviewer",
          description: "Reviews this workspace.",
          scope: "workspace",
        },
      ]);
      NodeFS.rmSync(root, { recursive: true });
    }),
  );

  it.effect("keeps built-ins when custom mode files are malformed", () =>
    Effect.gen(function* () {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-bob-modes-"));
      NodeFS.mkdirSync(NodePath.join(root, ".bob"), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(root, ".bob", "custom_modes.yaml"), "customModes: [");
      const modes = yield* discoverBobModes(root, { HOME: NodePath.join(root, "home") });
      assert.deepStrictEqual(
        modes.map((mode) => mode.slug),
        ["agent", "ask", "plan"],
      );
      NodeFS.rmSync(root, { recursive: true });
    }),
  );
});
