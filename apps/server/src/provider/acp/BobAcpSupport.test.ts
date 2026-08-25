import { describe, expect, it } from "vite-plus/test";

import { buildBobAcpSpawnInput } from "./BobAcpSupport.ts";

describe("BobAcpSupport", () => {
  it("launches the native ACP server with the requested feature switches", () => {
    expect(
      buildBobAcpSpawnInput({
        bobSettings: { binaryPath: "/opt/bob" },
        cwd: "/workspace",
        environment: { BOB_LOG_LEVEL: "silent" },
        disableMcp: true,
        disableSubagents: true,
      }),
    ).toEqual({
      command: "/opt/bob",
      args: ["acp", "--disable-mcp", "--disable-subagents"],
      cwd: "/workspace",
      env: { BOB_LOG_LEVEL: "silent" },
    });
  });

  it("keeps Bob MCP and subagents enabled for provider sessions", () => {
    expect(
      buildBobAcpSpawnInput({
        bobSettings: { binaryPath: "" },
        cwd: "/workspace",
      }),
    ).toEqual({
      command: "bob",
      args: ["acp"],
      cwd: "/workspace",
    });
  });
});
