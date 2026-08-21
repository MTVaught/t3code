import { describe, expect, it } from "vite-plus/test";

import {
  filterDiffFiles,
  isWideDiffPanelWidth,
  moveActiveDiffFile,
  resolveActiveDiffFile,
} from "./diffFileNavigation";

const FILES = [
  { filePath: "apps/web/src/components/ChatView.tsx" },
  { filePath: "apps/web/src/components/DiffPanel.tsx" },
  { filePath: "packages/contracts/src/review.ts" },
] as const;

describe("isWideDiffPanelWidth", () => {
  it("uses unified layout below the split-view width threshold", () => {
    expect(isWideDiffPanelWidth(759)).toBe(false);
    expect(isWideDiffPanelWidth(760)).toBe(true);
  });
});

describe("resolveActiveDiffFile", () => {
  it("uses the preferred file when it is still present", () => {
    expect(resolveActiveDiffFile(FILES, FILES[1].filePath)).toBe(FILES[1]);
  });

  it("falls back to the first file when the selection disappeared", () => {
    expect(resolveActiveDiffFile(FILES, "removed.ts")).toBe(FILES[0]);
    expect(resolveActiveDiffFile([], "removed.ts")).toBeUndefined();
  });
});

describe("moveActiveDiffFile", () => {
  it("moves in either direction and wraps at the ends", () => {
    expect(moveActiveDiffFile(FILES, FILES[0].filePath, -1)).toBe(FILES[2]);
    expect(moveActiveDiffFile(FILES, FILES[2].filePath, 1)).toBe(FILES[0]);
    expect(moveActiveDiffFile(FILES, FILES[1].filePath, 1)).toBe(FILES[2]);
  });

  it("recovers from a stale selection", () => {
    expect(moveActiveDiffFile(FILES, "removed.ts", 1)).toBe(FILES[0]);
    expect(moveActiveDiffFile([], null, 1)).toBeUndefined();
  });
});

describe("filterDiffFiles", () => {
  it("matches case-insensitively against the complete path", () => {
    expect(filterDiffFiles(FILES, "diffpanel")).toEqual([FILES[1]]);
    expect(filterDiffFiles(FILES, "PACKAGES/CONTRACTS")).toEqual([FILES[2]]);
  });

  it("returns every file for an empty query", () => {
    expect(filterDiffFiles(FILES, "   ")).toEqual(FILES);
  });
});
