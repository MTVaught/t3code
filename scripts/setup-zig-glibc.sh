#!/usr/bin/env bash
# Point the C/C++ toolchain at an OLD glibc target so native node addons
# compiled during the Linux desktop build (notably node-pty's pty.node) run on
# RHEL8 (glibc 2.28). glibc symbol versions come from the sysroot, not a gcc
# flag, so we use `zig cc`, which bundles glibc stubs for a chosen version and
# can target it via `-target <arch>-linux-gnu.<glibc>`.
#
# Installs zig, writes thin cc/c++ wrappers that pin the target, and exports
# CC/CXX via $GITHUB_ENV for the subsequent build step. node-gyp (used by both
# `pnpm install` and electron-builder's native rebuild) honours CC/CXX, so the
# resulting pty.node references at most GLIBC_<TARGET_GLIBC>.
set -euo pipefail

ZIG_VERSION="${ZIG_VERSION:-0.13.0}"
TARGET_GLIBC="${TARGET_GLIBC:-2.28}"
arch="$(uname -m)" # x86_64 / aarch64
url="https://ziglang.org/download/${ZIG_VERSION}/zig-linux-${arch}-${ZIG_VERSION}.tar.xz"
dest="${RUNNER_TEMP:-/tmp}/zig"

echo "Installing zig ${ZIG_VERSION} (target ${arch}-linux-gnu.${TARGET_GLIBC})"
mkdir -p "$dest"
curl -fsSL "$url" | tar -xJ -C "$dest" --strip-components=1
zig_bin="$dest/zig"
"$zig_bin" version

# Wrapper scripts so node-gyp can invoke a plain `cc`/`c++` while we inject the
# target triple. Wrappers avoid the word-splitting pitfalls of CC="zig cc ...".
mkdir -p "$dest/bin"
cat >"$dest/bin/cc" <<EOF
#!/usr/bin/env bash
exec "$zig_bin" cc -target ${arch}-linux-gnu.${TARGET_GLIBC} "\$@"
EOF
cat >"$dest/bin/c++" <<EOF
#!/usr/bin/env bash
exec "$zig_bin" c++ -target ${arch}-linux-gnu.${TARGET_GLIBC} "\$@"
EOF
chmod +x "$dest/bin/cc" "$dest/bin/c++"

if [[ -n "${GITHUB_ENV:-}" ]]; then
  {
    echo "CC=$dest/bin/cc"
    echo "CXX=$dest/bin/c++"
  } >>"$GITHUB_ENV"
fi
echo "Old-glibc (${TARGET_GLIBC}) toolchain ready: CC=$dest/bin/cc CXX=$dest/bin/c++"
