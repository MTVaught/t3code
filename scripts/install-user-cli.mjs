import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform === "win32") {
  throw new Error("The user-local T3 CLI installer currently supports macOS and Linux.");
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entryPath = join(repoRoot, "apps/server/dist/bin.mjs");
const binDir = join(homedir(), ".local/bin");
const linkPath = join(binDir, "t3");

const build = spawnSync("vp", ["run", "--filter", "t3", "build:bundle"], {
  cwd: repoRoot,
  stdio: "inherit",
});

if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);

mkdirSync(binDir, { recursive: true, mode: 0o700 });
chmodSync(binDir, 0o700);
chmodSync(entryPath, 0o700);

if (existsSync(linkPath) || lstatExists(linkPath)) {
  const stat = lstatSync(linkPath);
  if (!stat.isSymbolicLink()) {
    throw new Error(
      `${linkPath} already exists and is not a symbolic link; remove it explicitly first.`,
    );
  }

  const currentTarget = resolve(dirname(linkPath), readlinkSync(linkPath));
  if (currentTarget !== entryPath) unlinkSync(linkPath);
}

if (!existsSync(linkPath)) {
  symlinkSync(relative(binDir, entryPath), linkPath);
}

process.stdout.write(`Installed ${linkPath} -> ${entryPath}\n`);
if (!(process.env.PATH ?? "").split(":").includes(binDir)) {
  process.stdout.write(`Add this to your shell profile:\n  export PATH="${binDir}:$PATH"\n`);
}

function lstatExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error && error.code === "ENOENT") return false;
    throw error;
  }
}
