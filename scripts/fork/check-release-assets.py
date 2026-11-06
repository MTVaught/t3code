#!/usr/bin/env python3
"""Require the selected platforms and verify that stable feeds name this version."""
import pathlib
import json
import re
import sys

root = pathlib.Path(sys.argv[1])
version, channel = sys.argv[2:]
required = [f"t3-{version}-darwin-arm64.tar.gz", f"t3-{version}-linux-x64.tar.gz", f"T3-Code-{version}-arm64.dmg", f"T3-Code-{version}-arm64.zip",  "macos-signing.txt"]
if channel == "stable":
    required += ["latest-mac.yml"]
for name in required:
    file = root / name
    if not file.is_file() or file.stat().st_size == 0:
        raise SystemExit(f"Missing release artifact: {name}")
allowed = set(required) | {
    "SHA256SUMS", "release-metadata.json",
    f"T3-Code-{version}-arm64.dmg.blockmap",
    f"T3-Code-{version}-arm64.zip.blockmap",
}
for file in root.iterdir():
    if file.name not in allowed:
        raise SystemExit(f"Unsupported release artifact: {file.name}")
for name in ["latest-mac.yml"] if channel == "stable" else []:
    text = (root / name).read_text()
    if f"version: {version}\n" not in text:
        raise SystemExit(f"{name} does not describe {version}")
print("Release contains both supported platforms and matching update feeds.")

migrations = pathlib.Path("apps/server/src/persistence/Migrations")
ids = [int(match.group(1)) for file in migrations.iterdir() if (match := re.match(r"(\d+)_\w+\.ts$", file.name))]
if not ids:
    raise SystemExit("No server migrations found; cannot publish update compatibility metadata")
(root / "release-metadata.json").write_text(json.dumps({"version": version, "t3code": {"databaseMigration": max(ids)}}) + "\n")
