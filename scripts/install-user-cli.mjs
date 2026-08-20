import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

// oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone installer has no Effect runtime.
if (NodeOS.platform() === "win32") {
  throw new Error("The user-local T3 CLI installer currently supports macOS and Linux.");
}

const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const entryPath = NodePath.join(repoRoot, "apps/server/dist/bin.mjs");
const binDir = NodePath.join(NodeOS.homedir(), ".local/bin");
const linkPath = NodePath.join(binDir, "t3");

const build = NodeChildProcess.spawnSync("vp", ["run", "--filter", "t3", "build:bundle"], {
  cwd: repoRoot,
  stdio: "inherit",
});

if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);

NodeFS.mkdirSync(binDir, { recursive: true, mode: 0o700 });
NodeFS.chmodSync(binDir, 0o700);
NodeFS.chmodSync(entryPath, 0o700);

if (NodeFS.existsSync(linkPath) || lstatExists(linkPath)) {
  const stat = NodeFS.lstatSync(linkPath);
  if (!stat.isSymbolicLink()) {
    throw new Error(
      `${linkPath} already exists and is not a symbolic link; remove it explicitly first.`,
    );
  }

  const currentTarget = NodePath.resolve(NodePath.dirname(linkPath), NodeFS.readlinkSync(linkPath));
  if (currentTarget !== entryPath) NodeFS.unlinkSync(linkPath);
}

if (!NodeFS.existsSync(linkPath)) {
  NodeFS.symlinkSync(NodePath.relative(binDir, entryPath), linkPath);
}

process.stdout.write(`Installed ${linkPath} -> ${entryPath}\n`);
if (!(process.env.PATH ?? "").split(":").includes(binDir)) {
  process.stdout.write(`Add this to your shell profile:\n  export PATH="${binDir}:$PATH"\n`);
}

function lstatExists(path) {
  try {
    NodeFS.lstatSync(path);
    return true;
  } catch (error) {
    if (error && error.code === "ENOENT") return false;
    throw error;
  }
}
