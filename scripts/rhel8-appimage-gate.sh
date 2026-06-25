#!/usr/bin/env bash
# RHEL8 launch gate for the Linux AppImage.
#
# Runs inside a RHEL8-ABI-compatible container (rockylinux:8 / almalinux:8 /
# ubi8 -- all ship glibc 2.28, identical to RHEL8) and asserts that the packaged
# desktop app actually launches there. Exits non-zero (fails CI) on any failure
# so the app can never silently regress for RHEL8 users.
#
# Usage: rhel8-appimage-gate.sh <path-to-AppImage>
#
# The build host's glibc is irrelevant here: Electron ships as a prebuilt
# binary, so this gate tests the binary that real users actually run.
set -uo pipefail

APPIMAGE="$(readlink -f "${1:?usage: rhel8-appimage-gate.sh <path-to-AppImage>}")"
RHEL8_GLIBC="2.28"
fail=0
note() {
  echo "::error::RHEL8 gate: $*"
  fail=1
}

echo "::group::Distro + glibc"
sed -n '1,3p' /etc/os-release
ldd --version | head -1
echo "::endgroup::"

echo "::group::Install runtime + diagnostic dependencies"
# epel-release helps on UBI8; harmless elsewhere.
dnf -y install epel-release >/dev/null 2>&1 || true
dnf -y install \
  binutils file findutils tar procps-ng coreutils \
  xorg-x11-server-Xvfb \
  fuse fuse-libs \
  nss nspr atk at-spi2-atk at-spi2-core cups-libs \
  libdrm mesa-libgbm libxkbcommon \
  libX11 libXcomposite libXdamage libXext libXfixes libXrandr libxcb libXScrnSaver libXtst \
  pango cairo gdk-pixbuf2 gtk3 \
  alsa-lib libnotify libuuid >/dev/null 2>&1 ||
  echo "WARN: some dependencies failed to install (repo coverage differs by image)"
echo "::endgroup::"

WORKDIR="$(mktemp -d)"
cp "$APPIMAGE" "$WORKDIR/app.AppImage"
cd "$WORKDIR"
chmod +x app.AppImage

echo "::group::1. Extract AppImage (userspace, no FUSE required)"
if ! ./app.AppImage --appimage-extract >/tmp/extract.log 2>&1; then
  tail -30 /tmp/extract.log
  note "AppImage failed to extract (runtime could not execute)"
fi
echo "::endgroup::"

# executableName is "t3code" in the electron-builder config.
BIN="squashfs-root/t3code"
if [[ ! -x "$BIN" ]]; then
  BIN="$(find squashfs-root -maxdepth 1 -type f -perm -u+x ! -name '*.so*' 2>/dev/null | head -1)"
fi
echo "Main binary: ${BIN:-<none found>}"

if [[ -z "${BIN:-}" || ! -x "$BIN" ]]; then
  note "could not locate the app executable inside the AppImage"
else
  file "$BIN"

  echo "::group::2. Highest GLIBC symbol required (binary + bundled .so files)"
  highest="$(
    {
      objdump -T "$BIN" 2>/dev/null
      find squashfs-root -name '*.so*' -exec objdump -T {} \; 2>/dev/null
    } | grep -oE 'GLIBC_[0-9.]+' | sort -uV | tail -1
  )"
  echo "highest required: ${highest:-unknown}  |  RHEL8 provides GLIBC_${RHEL8_GLIBC}"
  ver="${highest#GLIBC_}"
  if [[ -n "$ver" && "$(printf '%s\n%s\n' "$ver" "$RHEL8_GLIBC" | sort -V | tail -1)" != "$RHEL8_GLIBC" ]]; then
    note "app requires ${highest}, which exceeds RHEL8's GLIBC_${RHEL8_GLIBC}. Electron 41 cannot run on RHEL8 (needs RHEL9/glibc 2.34, or an older Electron). Rebuilding on an older Ubuntu will NOT help -- the requirement is in Electron's prebuilt binary."
  fi
  echo "::endgroup::"

  echo "::group::3. Missing shared libraries (ldd)"
  if ldd "$BIN" 2>&1 | grep -E "not found"; then
    note "the app links against shared libraries not present on RHEL8 (see above)"
  else
    echo "(ldd: nothing missing)"
  fi
  echo "::endgroup::"

  echo "::group::4. Attempt real launch under Xvfb"
  export DISPLAY=:99
  Xvfb :99 -screen 0 1280x720x24 >/tmp/xvfb.log 2>&1 &
  xvfb_pid=$!
  sleep 2
  # --no-sandbox is required inside containers (no user namespaces).
  "$BIN" --no-sandbox --disable-gpu --enable-logging=stderr >/tmp/launch.log 2>&1 &
  app_pid=$!
  alive=0
  for _ in $(seq 1 15); do
    if kill -0 "$app_pid" 2>/dev/null; then
      alive=1
      sleep 1
    else
      alive=0
      break
    fi
  done
  kill "$app_pid" 2>/dev/null
  kill "$xvfb_pid" 2>/dev/null
  echo "---- launch output (head) ----"
  head -80 /tmp/launch.log
  fatal="$(grep -E "error while loading shared libraries|version \`GLIBC_[0-9.]+' not found|symbol lookup error|Segmentation fault|MODULE_NOT_FOUND|Cannot find module" /tmp/launch.log | head -5)"
  if [[ "$alive" -ne 1 ]]; then
    note "app process crashed during launch (did not stay alive)"
  fi
  if [[ -n "$fatal" ]]; then
    note "fatal launch errors detected:"
    printf '%s\n' "$fatal"
  fi
  echo "::endgroup::"
fi

if [[ "$fail" -ne 0 ]]; then
  echo "RHEL8 launch gate: FAIL"
  exit 1
fi
echo "RHEL8 launch gate: PASS -- the AppImage launches on RHEL8 (glibc ${RHEL8_GLIBC})."
