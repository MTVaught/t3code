import * as NodeOS from "node:os";

import type { ServerProviderMode } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { parse as parseYaml } from "yaml";

const BUILT_IN_MODES: ReadonlyArray<ServerProviderMode> = [
  {
    slug: "agent",
    name: "Agent",
    description: "Complete tasks with Bob's available tools.",
    scope: "built-in",
  },
  {
    slug: "ask",
    name: "Ask",
    description: "Answer questions without changing the workspace.",
    scope: "built-in",
  },
  {
    slug: "plan",
    name: "Plan",
    description: "Plan an approach before implementation.",
    scope: "built-in",
  },
];

function parseModes(
  contents: string,
  scope: "global" | "workspace",
): ReadonlyArray<ServerProviderMode> {
  try {
    const parsed = parseYaml(contents) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    const customModes = (parsed as Record<string, unknown>).customModes;
    if (!Array.isArray(customModes)) return [];
    return customModes.flatMap((candidate) => {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
      const record = candidate as Record<string, unknown>;
      const slug = typeof record.slug === "string" ? record.slug.trim() : "";
      const name = typeof record.name === "string" ? record.name.trim() : "";
      const description = typeof record.description === "string" ? record.description.trim() : "";
      if (!slug || !name) return [];
      return [{ slug, name, ...(description ? { description } : {}), scope }];
    });
  } catch {
    return [];
  }
}

/** Discover the modes Bob resolves for a workspace, using its most-specific-wins precedence. */
export const discoverBobModes = Effect.fn("discoverBobModes")(function* (
  cwd: string,
  environment: NodeJS.ProcessEnv,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = environment.HOME?.trim() || NodeOS.homedir();
  const roots = [
    { file: path.join(home, ".bob", "custom_modes.json"), scope: "global" as const },
    { file: path.join(home, ".bob", "custom_modes.yaml"), scope: "global" as const },
    { file: path.join(home, ".bob", "settings", "custom_modes.json"), scope: "global" as const },
    { file: path.join(home, ".bob", "settings", "custom_modes.yaml"), scope: "global" as const },
    { file: path.join(cwd, ".bob", "custom_modes.json"), scope: "workspace" as const },
    { file: path.join(cwd, ".bob", "custom_modes.yaml"), scope: "workspace" as const },
  ];
  const modes = new Map(BUILT_IN_MODES.map((mode) => [mode.slug, mode]));
  for (const root of roots) {
    const contents = yield* fileSystem
      .readFileString(root.file)
      .pipe(Effect.orElseSucceed(() => undefined));
    if (contents === undefined) continue;
    for (const mode of parseModes(contents, root.scope)) modes.set(mode.slug, mode);
  }
  return [...modes.values()];
});
