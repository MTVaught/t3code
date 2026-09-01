/** Filesystem discovery of IBM Bob custom modes for the composer mode picker. */
import * as NodeOS from "node:os";

import type { ServerProviderMode } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { parse as parseYamlDocument } from "yaml";

const MODES_FILE = "custom_modes.yaml";

function parseModesFile(
  contents: string,
  scope: ServerProviderMode["scope"],
): ReadonlyArray<ServerProviderMode> {
  let parsed: unknown;
  try {
    parsed = parseYamlDocument(contents);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];
  const entries = (parsed as { customModes?: unknown }).customModes;
  if (!Array.isArray(entries)) return [];
  const modes: Array<ServerProviderMode> = [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const mode = entry as Record<string, unknown>;
    const slug = typeof mode.slug === "string" ? mode.slug.trim() : "";
    if (!slug) continue;
    const name = typeof mode.name === "string" && mode.name.trim() ? mode.name.trim() : slug;
    const description = typeof mode.description === "string" ? mode.description.trim() : "";
    modes.push({ slug, name, scope, ...(description ? { description } : {}) });
  }
  return modes;
}

interface CachedModes {
  readonly fingerprint: string;
  readonly modes: ReadonlyArray<ServerProviderMode>;
}

// Composers poll project metadata while mounted; only re-parse the YAML when
// a modes file changes.
const modesCacheByRoots = new Map<string, CachedModes>();

const fileMtime = (target: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const info = yield* fileSystem.stat(target).pipe(Effect.orElseSucceed(() => undefined));
    const mtime = info?.mtime;
    return mtime && mtime._tag === "Some" ? String(mtime.value.getTime()) : "missing";
  });

/**
 * Bob loads global modes from `~/.bob/settings/custom_modes.yaml` and workspace
 * modes from `.bob/custom_modes.yaml` plus `.bob/<dir>/custom_modes.yaml`.
 * This mirrors what a running session later advertises over ACP so the picker
 * is populated before the first turn.
 */
export const discoverBobModes = Effect.fn("discoverBobModes")(function* (
  cwd: string,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<ReadonlyArray<ServerProviderMode>, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = environment.HOME?.trim() || NodeOS.homedir();
  const workspaceBobDir = path.join(cwd, ".bob");
  const workspaceEntries = yield* fileSystem
    .readDirectory(workspaceBobDir)
    .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
  const files: ReadonlyArray<{ file: string; scope: ServerProviderMode["scope"] }> = [
    { file: path.join(home, ".bob", "settings", MODES_FILE), scope: "global" },
    { file: path.join(workspaceBobDir, MODES_FILE), scope: "workspace" },
    ...[...workspaceEntries].sort().map((entry) => ({
      file: path.join(workspaceBobDir, entry, MODES_FILE),
      scope: "workspace" as const,
    })),
  ];
  const mtimes = yield* Effect.forEach(files, ({ file }) => fileMtime(file));
  const cacheKey = `${home}|${cwd}`;
  const fingerprint = files.map(({ file }, index) => `${file}@${mtimes[index]}`).join("|");
  const cached = modesCacheByRoots.get(cacheKey);
  if (cached && cached.fingerprint === fingerprint) return cached.modes;

  const modesBySlug = new Map<string, ServerProviderMode>();
  for (const [index, { file, scope }] of files.entries()) {
    if (mtimes[index] === "missing") continue;
    const contents = yield* fileSystem
      .readFileString(file)
      .pipe(Effect.orElseSucceed(() => undefined));
    if (contents === undefined) continue;
    for (const mode of parseModesFile(contents, scope)) modesBySlug.set(mode.slug, mode);
  }
  const modes = [...modesBySlug.values()];
  modesCacheByRoots.set(cacheKey, { fingerprint, modes });
  return modes;
});

/** Built-in modes first, then discovered modes; a custom slug never shadows a built-in. */
export function mergeBobModes(
  builtIn: ReadonlyArray<ServerProviderMode>,
  discovered: ReadonlyArray<ServerProviderMode>,
): ReadonlyArray<ServerProviderMode> {
  const slugs = new Set(builtIn.map((mode) => mode.slug));
  return [...builtIn, ...discovered.filter((mode) => !slugs.has(mode.slug))];
}
