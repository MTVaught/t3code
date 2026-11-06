#!/usr/bin/env python3
"""Reject packaged ELF files that require a newer userspace than RHEL 8."""
import pathlib
import re
import subprocess
import sys

limits = {"GLIBC": (2, 28), "GLIBCXX": (3, 4, 25), "CXXABI": (1, 3, 11)}
errors = []
for root in sys.argv[1:]:
    for file in pathlib.Path(root).rglob("*"):
        if not file.is_file():
            continue
        with file.open("rb") as handle:
            header = handle.read(20)
        if not header.startswith(b"\x7fELF"):
            continue
        # Packages can include other architectures; they cannot load on Linux x64.
        if len(header) < 20 or int.from_bytes(header[18:20], "little") != 62:
            continue
        versions = subprocess.run(["readelf", "--version-info", str(file)], capture_output=True, text=True, check=True).stdout
        for family, value in re.findall(r"\b(GLIBCXX|GLIBC|CXXABI)_([0-9.]+)\b", versions):
            if tuple(map(int, value.split("."))) > limits[family]:
                errors.append(f"{file}: requires {family}_{value}")
if errors:
    raise SystemExit("\n".join(sorted(set(errors))))
print("ELF userspace requirements fit RHEL 8.")
