/** Filesystem discovery of IBM Bob skills for the composer skill picker. */
import * as NodeOS from "node:os";

import type { ServerProviderSkill, ServerProviderSlashCommand } from "@t3tools/contracts";
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

  // Bob nests invocation flags under `metadata:` and falls back to top level.
  // Skills a user may not invoke never enter Bob's ACP command catalog, so
  // offering them would only produce a prompt Bob passes through verbatim.
  const nested =
    typeof metadata.metadata === "object" && metadata.metadata !== null
      ? (metadata.metadata as Record<string, unknown>)
      : {};
  if ((nested["user-invocable"] ?? metadata["user-invocable"]) === false) return undefined;
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

interface CachedSkills {
  readonly fingerprint: string;
  readonly skills: ReadonlyArray<ServerProviderSkill>;
}

// Composers poll project metadata while mounted; only re-parse SKILL.md files
// when a skills directory or one of its SKILL.md files changes.
const skillsCacheByRoots = new Map<string, CachedSkills>();

const fileMtime = (target: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const info = yield* fileSystem.stat(target).pipe(Effect.orElseSucceed(() => undefined));
    const mtime = info?.mtime;
    return mtime && mtime._tag === "Some" ? String(mtime.value.getTime()) : "missing";
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

  const listings = yield* Effect.forEach(roots, (root) =>
    Effect.gen(function* () {
      const entries = yield* fileSystem
        .readDirectory(root.directory)
        .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
      const sorted = [...entries].sort();
      const mtimes = yield* Effect.forEach(sorted, (entry) =>
        fileMtime(path.join(root.directory, entry, "SKILL.md")),
      );
      return { root, entries: sorted, mtimes };
    }),
  );
  const cacheKey = roots.map((root) => root.directory).join("|");
  const fingerprint = listings
    .flatMap((listing) =>
      listing.entries.map((entry, index) => `${entry}@${listing.mtimes[index]}`),
    )
    .join("|");
  const cached = skillsCacheByRoots.get(cacheKey);
  if (cached && cached.fingerprint === fingerprint) return cached.skills;

  const skillsByName = new Map<string, ServerProviderSkill>();
  for (const { root, entries } of listings) {
    for (const entry of entries) {
      const skill = yield* readSkill(
        path.join(root.directory, entry, "SKILL.md"),
        entry,
        root.scope,
      );
      if (skill) skillsByName.set(skill.name, skill);
    }
  }
  const skills = [...skillsByName.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  skillsCacheByRoots.set(cacheKey, { fingerprint, skills });
  return skills;
});

const SKILL_TOKEN_PATTERN = /(^|\s)\$([a-zA-Z][a-zA-Z0-9:_-]*)(?=\s|$)/g;

/**
 * Bob's ACP catalog (`available_commands_update`) is the authority on which
 * skills the current mode may invoke. While a session is reporting one, keep
 * only discovered skills it lists; before that, the filesystem scan stands.
 */
export function selectInvocableBobSkills(
  discovered: ReadonlyArray<ServerProviderSkill>,
  slashCommands: ReadonlyArray<Pick<ServerProviderSlashCommand, "name">>,
): ReadonlyArray<ServerProviderSkill> {
  if (slashCommands.length === 0) return discovered;
  const catalog = new Set(slashCommands.map((command) => command.name));
  return discovered.filter((skill) => catalog.has(skill.name));
}

/**
 * Over ACP, Bob loads a skill only when the prompt is `/name [argument]`; a
 * `$name` inside text reaches the model verbatim, which fails for skills with
 * `disable-model-invocation`. Every `$skill` naming a known skill becomes its
 * own `/name` prompt, and the message rides along as the last one's argument.
 * Unknown `$tokens` (env vars, prices) stay put.
 */
export function splitBobSkillPreludes(
  text: string,
  skills: ReadonlyArray<Pick<ServerProviderSkill, "name">>,
): { readonly preludes: ReadonlyArray<string>; readonly text: string } {
  const known = new Set(skills.map((skill) => skill.name));
  const names: Array<string> = [];
  const remaining = text
    .replace(SKILL_TOKEN_PATTERN, (match, prefix: string, name: string) => {
      if (!known.has(name)) return match;
      if (!names.includes(name)) names.push(name);
      return prefix;
    })
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  if (names.length === 0) return { preludes: [], text: remaining };
  const commands = names.map((name) => `/${name}`);
  const last = commands.pop()!;
  return { preludes: commands, text: remaining ? `${last} ${remaining}` : last };
}
