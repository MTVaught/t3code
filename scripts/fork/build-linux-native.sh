#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
test "$(getconf GNU_LIBC_VERSION)" = 'glibc 2.28'
test "$(uname -m)" = x86_64
test "$(node --version)" = "v$(node -p 'require("./package.json").engines.node')"
output="$PWD/release/fork-native"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$output"
pty_version="$(node -p 'require("./apps/server/node_modules/node-pty/package.json").version')"
fff_version="$(node -p 'require("./apps/server/package.json").dependencies["@ff-labs/fff-node"]')"
# This revision is the source of the pinned npm wrapper's C ABI.
test "$fff_version" = 0.11.0 || { echo 'Update the fff source revision for the new dependency.' >&2; exit 1; }
npm install --ignore-scripts --prefix "$work/runtime" "node-pty@$pty_version"
(
  cd "$work/runtime/node_modules/node-pty"
  npx --yes node-gyp@12.4.0 configure
  # GCC 8 uses the provisional spelling for this C++20 language mode.
  sed -i 's/-std=gnu++20/-std=gnu++2a/g' build/*.mk
  make -C build BUILDTYPE=Release
)
cp "$work/runtime/node_modules/node-pty/build/Release/pty.node" "$output/pty.node"
git init -q "$work/fff"
git -C "$work/fff" fetch -q --depth=1 https://github.com/dmtrKovalenko/fff.git 95fd777c2529fc7b4d7572dabff64cc07268f2c5
git -C "$work/fff" checkout -q --detach FETCH_HEAD
cargo build --locked --release --manifest-path "$work/fff/Cargo.toml" --package fff-c --target x86_64-unknown-linux-gnu
cp "$work/fff/target/x86_64-unknown-linux-gnu/release/libfff_c.so" "$output/libfff_c.so"
cargo test --locked --manifest-path native/resource-monitor/Cargo.toml --target x86_64-unknown-linux-gnu
cargo build --locked --release --manifest-path native/resource-monitor/Cargo.toml --target x86_64-unknown-linux-gnu
cp native/resource-monitor/target/x86_64-unknown-linux-gnu/release/t3-resource-monitor "$output/t3-resource-monitor"
cp -L /usr/lib64/libatomic.so.1 "$output/libatomic.so.1"
{
  rpm -q --qf 'Rocky Linux 8 %{NAME} %{VERSION}-%{RELEASE}\nSource RPM: %{SOURCERPM}\n' libatomic
  printf 'Source: https://dl.rockylinux.org/pub/rocky/8/BaseOS/source/tree/Packages/\n\n'
  cat scripts/licenses/libatomic.LICENSE
} > "$output/libatomic.so.1.LICENSE"
python3.11 scripts/fork/check-linux-abi.py "$output"

# Docker builds must leave cache and staging outputs writable by the checkout owner.
chown --reference=package.json release
chown -R --reference=package.json "$output" native/resource-monitor/target
