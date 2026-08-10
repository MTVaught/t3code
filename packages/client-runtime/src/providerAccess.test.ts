import { describe, expect, it } from "vite-plus/test";

import { effectiveToolAccess, runtimeModeToolAccess } from "./providerAccess.ts";

describe("provider tool access", () => {
  it("maps runtime modes to Bob's headless access levels", () => {
    expect(runtimeModeToolAccess("approval-required")).toBe("read-only");
    expect(runtimeModeToolAccess("auto-accept-edits")).toBe("edits");
    expect(runtimeModeToolAccess("auto")).toBe("edits");
    expect(runtimeModeToolAccess("full-access")).toBe("full");
  });

  it("uses the stricter runtime mode and instance ceiling", () => {
    expect(effectiveToolAccess("approval-required", "full")).toBe("read-only");
    expect(effectiveToolAccess("auto", "read-only")).toBe("read-only");
    expect(effectiveToolAccess("full-access", "edits")).toBe("edits");
    expect(effectiveToolAccess("full-access", "full")).toBe("full");
  });
});
