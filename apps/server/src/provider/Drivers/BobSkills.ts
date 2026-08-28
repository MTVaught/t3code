/** Filesystem discovery of IBM Bob skills for the composer skill picker. */
import * as NodeOS from "node:os";

import type { ServerProviderSkill } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { parse as parseYamlDocument } from "yaml";

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

function parseFrontmatter(contents: string): Record<string, unknown> | undefined {
  const match = FRONTMATTER_PATTERN.exec(contents);
  if (!match) return {};
  try {
    const parsed: unknown = parseYamlDocument(match[1] ?? "");
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

const readSkill = Effect.fn("readBobSkill")(function* (
  skillPath: string,
  fallbackName: string,
  scope: "user" | "project",
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const contents = yield* fileSystem
    .readFileString(skillPath)
    .pipe(Effect.orElseSucceed(() => undefined));
  if (contents === undefined) return undefined;

  const metadata = parseFrontmatter(contents);
  if (!metadata) return undefined;

  const configuredName = typeof metadata.name === "string" ? metadata.name.trim() : "";
  const name = configuredName || fallbackName.trim();
  if (!name) return undefined;
  const description = typeof metadata.description === "string" ? metadata.description.trim() : "";
  return {
    name,
    path: skillPath,
    enabled: true,
    scope,
    ...(description ? { description } : {}),
  } satisfies ServerProviderSkill;
});

/** Bob loads user skills from `~/.bob/skills` and project skills from `.bob/skills`. */
export const discoverBobSkills = Effect.fn("discoverBobSkills")(function* (
  cwd: string,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = environment.HOME?.trim() || NodeOS.homedir();
  const roots = [
    { directory: path.join(home, ".bob", "skills"), scope: "user" as const },
    { directory: path.join(cwd, ".bob", "skills"), scope: "project" as const },
  ];

  const skillsByName = new Map<string, ServerProviderSkill>();
  for (const root of roots) {
    const entries = yield* fileSystem
      .readDirectory(root.directory)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    for (const entry of [...entries].sort()) {
      const skill = yield* readSkill(
        path.join(root.directory, entry, "SKILL.md"),
        entry,
        root.scope,
      );
      if (skill) skillsByName.set(skill.name, skill);
    }
  }
  return [...skillsByName.values()].sort((left, right) => left.name.localeCompare(right.name));
});
