import { describe, expect, it } from "vite-plus/test";

import {
  cliArchivePlatformKey,
  cliArchiveTarCommand,
  cliReleaseDownloadBaseUrl,
  cliReleaseIndexPageUrl,
  newestCliReleaseVersion,
  parseChecksums,
} from "./cliRelease.ts";

describe("cliRelease", () => {
  it("routes archive installation and release discovery to the fork", () => {
    expect(cliReleaseDownloadBaseUrl("0.1.7-treher.1")).toBe(
      "https://github.com/MTVaught/t3code/releases/download/v0.1.7-treher.1",
    );
    expect(cliReleaseIndexPageUrl(2)).toBe(
      "https://api.github.com/repos/MTVaught/t3code/releases?per_page=100&page=2",
    );
    expect(cliArchivePlatformKey("darwin", "arm64")).toBe("darwin-arm64");
    expect(cliArchivePlatformKey("linux", "x64")).toBe("linux-x64");
    for (const [platform, arch] of [
      ["win32", "x64"],
      ["win32", "arm64"],
      ["linux", "arm64"],
      ["darwin", "x64"],
    ] as const) {
      expect(cliArchivePlatformKey(platform, arch)).toBeUndefined();
    }
  });

  it("parses sha256sum output including binary-mode markers", () => {
    const checksums = parseChecksums(
      [
        `${"a".repeat(64)}  t3-1.2.3-linux-x64.tar.gz`,
        `${"B".repeat(64)} *t3-1.2.3-win32-x64.zip`,
        "not a checksum line",
        "",
      ].join("\n"),
    );
    expect(checksums.get("t3-1.2.3-linux-x64.tar.gz")).toBe("a".repeat(64));
    expect(checksums.get("t3-1.2.3-win32-x64.zip")).toBe("b".repeat(64));
    expect(checksums.size).toBe(2);
  });

  it("extracts with the System32 bsdtar on Windows and plain tar elsewhere", () => {
    expect(cliArchiveTarCommand("linux", {})).toBe("tar");
    expect(cliArchiveTarCommand("win32", { SystemRoot: "D:\\Win" })).toBe(
      "D:\\Win\\System32\\tar.exe",
    );
    expect(cliArchiveTarCommand("win32", {})).toBe("C:\\Windows\\System32\\tar.exe");
  });

  it("picks the newest non-draft release on the requested channel", () => {
    const releases = [
      { tag_name: "v1.2.4-preview.20260912.9", draft: true },
      { tag_name: "v1.2.4-preview.20260912.8" },
      { tag_name: "v1.2.4-nightly.20260912.7" },
      { tag_name: "desktop-preview" },
      { tag_name: "v1.2.3-treher.2.rc.1" },
      { tag_name: "v1.2.3-treher.2", draft: true },
      { tag_name: "v1.2.3-treher.1" },
      { tag_name: "v1.2.3" },
      { tag_name: "v1.2.3-nightly.20260911.2" },
    ];
    expect(newestCliReleaseVersion(releases, "preview")).toBe("1.2.4-preview.20260912.8");
    expect(newestCliReleaseVersion(releases, "nightly")).toBe("1.2.4-nightly.20260912.7");
    expect(newestCliReleaseVersion(releases, "stable")).toBe("1.2.3-treher.1");
    expect(newestCliReleaseVersion([{ tag_name: "v1.2.3" }], "preview")).toBeUndefined();
  });
});
