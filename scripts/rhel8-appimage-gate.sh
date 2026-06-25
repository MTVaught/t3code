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
# strict=0: install every package that resolves and skip (with a logged "No
# match for argument") any that the image's repos do not carry, instead of
# aborting the whole transaction on the first unknown name. Output is kept
# visible so the log shows exactly what is and is not available on RHEL8.
dnf -y --setopt=strict=0 install \
  binutils file findutils tar procps-ng coreutils \
  xorg-x11-server-Xvfb \
  fuse fuse-libs \
  nss nspr atk at-spi2-atk at-spi2-core cups-libs \
  libdrm mesa-libgbm libxkbcommon \
  libX11 libXcomposite libXdamage libXext libXfixes libXrandr libxcb libXScrnSaver libXtst \
  pango cairo gdk-pixbuf2 gtk3 \
  alsa-lib libnotify libuuid ||
  echo "WARN: dnf returned non-zero even with strict=0"
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
  echo "-- files that require GLIBC > ${RHEL8_GLIBC} (these break on RHEL8) --"
  find squashfs-root -type f \( -name '*.so*' -o -perm -u+x \) 2>/dev/null | while read -r f; do
    fv="$(objdump -T "$f" 2>/dev/null | grep -oE 'GLIBC_[0-9.]+' | sort -uV | tail -1)"
    fver="${fv#GLIBC_}"
    if [[ -n "$fver" && "$(printf '%s\n%s\n' "$fver" "$RHEL8_GLIBC" | sort -V | tail -1)" != "$RHEL8_GLIBC" ]]; then
      echo "  ${fv}  ${f#squashfs-root/}"
    fi
  done
  ver="${highest#GLIBC_}"
  if [[ -n "$ver" && "$(printf '%s\n%s\n' "$ver" "$RHEL8_GLIBC" | sort -V | tail -1)" != "$RHEL8_GLIBC" ]]; then
    note "a bundled component requires ${highest}, exceeding RHEL8's GLIBC_${RHEL8_GLIBC}. See the offender list above -- these are app-bundled native modules (e.g. node-pty, @ff-labs/fff-bin), NOT Electron itself (Electron's prebuilt is fine on RHEL8). Fix: build/obtain those natives against glibc <= ${RHEL8_GLIBC} (compile in a manylinux_2_28 / RHEL8 / Rocky8 container) or use a musl build."
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

  echo "::group::5. App-internal logs (backend child-process failures land here)"
  # The Electron main process may launch while a bundled child process (e.g.
  # the backend server / a native helper) crashes -- which still leaves the app
  # unusable. Surface those logs and the raw backend error.
  for d in "$HOME/.t3/userdata/logs" /root/.t3/userdata/logs; do
    if [[ -d "$d" ]]; then
      echo "---- ${d} ----"
      find "$d" -type f -exec sh -c 'echo "== $1 =="; tail -40 "$1"' _ {} \;
    fi
  done
  if grep -rqiE "GLIBC_[0-9.]+ not found|error while loading shared libraries" "$HOME/.t3" /root/.t3 2>/dev/null; then
    note "backend child process fails to load a glibc-too-new / missing library on RHEL8 (see logs above)"
  fi
  echo "::endgroup::"
fi

if [[ "$fail" -ne 0 ]]; then
  echo "RHEL8 launch gate: FAIL"
  exit 1
fi
echo "RHEL8 launch gate: PASS -- the AppImage launches on RHEL8 (glibc ${RHEL8_GLIBC})."
