const path = require("node:path");
const { createRequire } = require("node:module");
const root = process.argv[2];
const requirePackaged = createRequire(path.join(root, "native-check.cjs"));
const pty = requirePackaged("node-pty");
const terminal = pty.spawn("/bin/sh", ["-c", "printf rhel8-terminal-ok"], {
  name: "xterm",
  cols: 80,
  rows: 24,
});
let output = "";
terminal.onData((chunk) => {
  output += chunk;
});
terminal.onExit(async ({ exitCode }) => {
  try {
    if (exitCode !== 0 || !output.includes("rhel8-terminal-ok"))
      throw new Error("Packaged terminal failed");
    const { FileFinder } = requirePackaged("@ff-labs/fff-node");
    const result = FileFinder.create({ basePath: process.cwd(), disableMmapCache: true });
    if (!result.ok) throw new Error(result.error);
    const finder = result.value;
    try {
      const ready = await finder.waitForIndexReady(15000);
      const search = finder.fileSearch("rhel8-native-probe.txt", { pageSize: 10 });
      if (!ready.ok || !ready.value || !search.ok || search.value.items.length === 0)
        throw new Error("Packaged file search failed");
    } finally {
      finder.destroy();
    }
    console.log("Packaged terminal and file search work on RHEL 8.");
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
});
