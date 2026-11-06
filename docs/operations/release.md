# Fork builds and releases

The fork is based on upstream `v0.1.7`. It builds the macOS ARM64 desktop app and
macOS ARM64 / Linux x64 CLI archives. Linux desktop and Windows artifacts are
not built. [FORK.md](../../FORK.md) defines the product and contribution policy.

## CI and release controls

`.github/workflows/ci.yml` checks the desktop/server dependency graph and tooling
on standard GitHub-hosted runners. It runs a Linux CLI build and verifies that
archive on Rocky Linux 8. The final `Check` job requires every preceding job to
pass. Branch protection should require `Check`; remove required check names from
retired workflows when activating the new baseline.

`.github/workflows/release.yml` builds manual previews and tagged stable releases.
There are no scheduled or per-push nightlies. Publication uses the built-in
`GITHUB_TOKEN` and is restricted to `MTVaught/t3code`. It waits for CI, verification
of the exact Linux archive, and the macOS build. Untrusted PR jobs have no signing
or publishing secrets. Other upstream workflows are retained under
`.github/disabled-workflows`.

Before activation, preserve the old `main` as `archive/treher-main` and review
branch protection. The repository was archived with Actions disabled and had no
Actions secrets when checked on 2026-11-06. Unarchive it and enable Actions only
when the new workflow files are ready. Do not publish using the retired workflows.
Do not create or update an upstream PR without explicit user authorization.

## Version and release commands

A stable fork tag is `v<upstream-version>-treher.<sequence>`, for example
`v0.1.7-treher.1`. Use the actual upstream release base and start the sequence at
one for each base. Keep desktop and CLI versions equal. The tag's commit must be
on fork `main`. After the maintainer authorizes publication:

```sh
git tag v0.1.7-treher.1
git push origin v0.1.7-treher.1
```

For a preview, select **Actions → Release → Run workflow** and select the branch.
The version defaults to `0.1.7-preview.<YYYYMMDD>.<run>`. A supplied preview version
must use that form. Manual runs cannot publish a stable release. Previews are
GitHub prereleases, have no desktop update feed, and are not marked latest.
Stable fork releases are marked latest. There is no npm or package-manager
publication.

Stable installation and update selection accept final fork tags and exclude
release candidates and previews. A fork suffix sorts below its plain upstream
version in SemVer. Replacing an upstream install of the same base may therefore
need an explicit version and the normal downgrade checks. Never reuse an upstream
version string for a fork binary; the runtime cache is keyed by version.

## macOS signing

Use **Actions → macOS build → Run workflow** with a preview version to check
signing and notarization. This workflow uploads build artifacts without publishing
a GitHub release or changing the desktop update feed.

Configure these repository Actions secrets through GitHub's secret controls:

- `CSC_LINK`: base64-encoded Developer ID Application certificate and private key
  exported as a `.p12`.
- `CSC_KEY_PASSWORD`: the `.p12` password.
- `APPLE_API_KEY`: the notarization API private key text.
- `APPLE_API_KEY_ID` and `APPLE_API_ISSUER`: the corresponding key and issuer IDs.

All five must be configured together. With none configured, the workflow produces
an unsigned desktop build and an ad hoc signed CLI. Release notes state that the
macOS build is unsigned and not notarized. Partial configuration fails the build.
A signed build must pass signing and notarization; it does not fall back silently.

Standard Developer ID signing needs no hosted relay or Clerk credentials. To
use the existing passkey provisioning path, also configure the
`MACOS_PROVISIONING_PROFILE` secret and repository variables `APPLE_TEAM_ID` and
`CLERK_PASSKEY_RP_DOMAINS` for domains controlled by the maintainer. Do not use
upstream credentials or domains. Signing files live only in the runner's temporary
directory and are removed at the end of the job. Never commit them.

## RHEL 8 CLI verification

The containers in `scripts/fork/Dockerfile` are CI tools. Users install and run
the CLI directly on RHEL 8. No Docker, Podman, Apptainer, replacement glibc, or
compiler is required on the target system.

The builder uses stock Rocky Linux 8 and rebuilds `node-pty`, fff's C library,
and the resource monitor. The archive uses the supported official Node runtime
and carries Rocky's `libatomic` with its license and source-package reference.
It does not carry glibc or its loader. Packaging replaces the terminal and fff
prebuilds after installing the runtime dependencies.

To reproduce on a development machine with Docker and workspace dependencies:

```sh
mkdir -p release/fork-native release/verification
docker build --target builder -t t3-fork-rhel8-builder -f scripts/fork/Dockerfile scripts/fork
docker build --target runtime -t t3-fork-rhel8-runtime -f scripts/fork/Dockerfile scripts/fork
docker run --rm -v "$PWD:/workspace" -w /workspace t3-fork-rhel8-builder bash scripts/fork/build-linux-native.sh
```

The workflow then builds the server and web client, creates the CLI archive with
`T3CODE_LINUX_NATIVE_PREBUILDS` set to the native output directory, and passes the
archive to the clean runtime check:

```sh
docker run --rm -v "$PWD:/workspace:ro" -v "$PWD/release/linux:/artifacts:ro" -v "$PWD/release/verification:/logs" t3-fork-rhel8-runtime python3.11 /workspace/scripts/fork/verify-linux.py /artifacts /logs
```

The check rejects newer glibc, libstdc++, and C++ ABI requirements and any bundled
glibc or loader. It exercises the packaged terminal and file finder, checks the
resource monitor, and starts the exact CLI with no host Node on `PATH`. Server
readiness and an HTTP response are required. The Node binary in the test image
is only a test driver for the packaged native modules. It is not installed on
users' systems. Logs are uploaded on failures as well as successful runs.

The base image digest, Rust version, Node version, lockfile, and fff source
revision are build inputs. Update them through normal dependency review. If the
fff version changes, update its source revision in `build-linux-native.sh` and
check its C ABI against the wrapper. Rebuild after security fixes in those
inputs. A cache hit never replaces verification of the final archive. Do not
remove a check or replace host glibc to pass a dependency update.

Container verification checks RHEL 8-compatible userspace on the runner's kernel.
After changes to kernel-dependent behavior, verify on a RHEL 8 or Rocky Linux 8 VM.
Provider executables need their own OS compatibility checks.

## Installation and updates

Publish both CLI archives, the macOS DMG and updater ZIP, `latest-mac.yml` for
stable releases, `SHA256SUMS`, and `release-metadata.json`. The last file carries
the release version and database migration bound for update preflight checks.
The legacy `server.getNpmRelease` RPC reads this GitHub metadata; it does not
require npm or query upstream's npm releases. Nightly lookup returns unpublished.

The installer, CLI updates, desktop feed, SSH runtime downloads, and recovery
links target the fork. The shell installer keeps the `t3` link in `~/.local/bin`
and runtime versions under `~/.t3/runtime/versions`. State stays under upstream's
normal `~/.t3` and desktop profile paths. There is no `.t3-treher` profile or data
migration. Do not run two servers against the same data directory.

Re-running the installer changes the command link. A running background service
continues using its current runtime until updated. Use `t3 update` for an installed
service and wait for its normal restart and migration checks.
