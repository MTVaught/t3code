# Fork intent and build policy

`MTVaught/t3code` is a small downstream fork based on upstream release `v0.1.7`,
commit `322f6544dfad0a3c8a0c8cbecf2c7f7874b14268`. Start from the upstream release,
not the retired fork. Keep upstream behavior unless a focused fix or a requirement
in this file needs a change. This policy takes precedence over inherited upstream
product and release guidance where they differ.

## Product and build scope

| Target      | Desktop                           | CLI                                       |
| ----------- | --------------------------------- | ----------------------------------------- |
| macOS ARM64 | DMG, updater ZIP, and update feed | `.tar.gz` archive                         |
| Linux x64   | Not built                         | `.tar.gz` archive, compatible with RHEL 8 |

Retain upstream source for other platforms and clients. Do not build or publish
Linux desktop apps, Windows, macOS x64, Linux ARM64, mobile apps, hosted web or
marketing deployments, T3 Connect relay deployments, or external service webhooks.
Do not publish to npm, AUR, or other package managers. Keep inherited workflows
outside `.github/workflows` until they have a use in this fork.

Keep the bundled web client, server packages, provider packages, and SSH support.
Do not remove dependencies only because a separate web or mobile app is not shipped.
The desktop uses the same protocol as upstream's independently versioned CLI.
Preserve protocol and database compatibility when changing shared contracts.

Keep upstream's application identity, URL schemes, command names, provider
defaults, profile directories, and database schema. The fork replaces an upstream
install and reuses its data. Do not introduce `.t3-treher` or restore the retired
fork's provider adapters, defaults, interface changes, or security policy changes
without a maintainer request. ACP mode display and ACP text generation are separate
future product changes; neither is part of this setup.

Use supported controls to disable optional analytics, error and feedback uploads,
and model training or data-sharing opt-ins. Keep diagnostic logs local and record
account controls that cannot be verified. Fork server bundles default optional
telemetry to off. Do not copy provider credentials into builds.

## CI and releases

Use standard GitHub-hosted runners: `ubuntu-24.04` for general checks and Linux CLI
builds, and `macos-26` for macOS ARM64 packaging. Do not require Blacksmith, larger
paid runners, self-hosted runners, upstream task-cache services, or upstream secrets.

CI checks formatting, lint, unused code, and the desktop/server dependency graph's
types and tests, including providers, the bundled web client, shared runtime, and
contributor tooling. The Linux CLI is built and verified on every CI run. Keep one
final `Check` job for branch protection. It must fail when a required job fails or
is cancelled. Fork CI does not require mobile, marketing, or relay jobs.

Release only from explicit stable tags or manual preview builds. Do not enable
scheduled or per-push nightlies. Use the same selected commit and version for
desktop and CLI artifacts. Publication must wait for all checks, the macOS build,
and verification of the exact Linux archive selected for publication.

Use read-only workflow permissions by default. Give release publishing write
access only in its publishing job and guard it with the exact repository owner
`MTVaught/t3code`. Untrusted PR checks must not receive signing or publishing
secrets. Use existing Developer ID signing and notarization when configured.
Clearly identify unsigned builds. Keep signing files out of Git.

Stable tags use `v<upstream-version>-treher.<sequence>`. Record the actual upstream
release base and increment the sequence from one for each fork release on that
base. Stable selection accepts final fork tags and rejects candidates and
previews. Preview versions use `<upstream-version>-preview.<YYYYMMDD>.<run>`;
previews have no desktop update feed and are not marked latest.

## Install paths and update source

All release consumers must use this fork's GitHub Releases: shell installer,
CLI updates, desktop feeds, SSH runtime downloads, recovery links, and update
compatibility metadata. Retain upstream checksum verification and service update
checks. Reject unsupported targets before attempting a download.

Keep the `t3` link in `~/.local/bin`, T3 home at `~/.t3`, and versioned CLI archives
under `~/.t3/runtime/versions`. Keep upstream's desktop profile and service identity.
A fork suffix sorts below its plain upstream version in SemVer; switching between
builds of the same base may need an explicit version and normal downgrade checks.
Never reuse an upstream version string for different fork binaries.

Sharing paths permits replacing one build with the other. It does not permit two
servers to write the same state directory or guarantee that an older build can
read newer database migrations. Keep upstream backup and downgrade checks.
Development and verification must use isolated state, never the live database.

## RHEL 8 CLI support

RHEL 8 x64 support applies to the CLI server only. Leave host glibc unchanged.
The user must not need a container runtime, compiler, custom glibc, or modified
system loader. Provider CLIs need their own RHEL 8 support.

CI uses stock Rocky Linux 8 containers, pinned by digest, to rebuild incompatible
native dependencies and test the final archive. Keep these scripts shared between
CI and local reproduction. Use upstream source matching the selected dependency
versions; keep source revisions aligned when updating packages. Rebuild after
security fixes and review the base image, toolchain, and Node runtime on updates.
This compatibility work is a maintenance responsibility, not only a CI setting.

Keep required native dependencies at the glibc 2.28 and RHEL 8 C++ ABI floor.
Package the verified binaries after dependency installation so newer prebuilds
cannot overwrite them. Cache by source, dependencies, runtime ABI, toolchain,
and image digest; a cache hit never replaces final artifact verification.

Verification rejects a bundled glibc or loader, newer symbol requirements, and
missing runtime libraries. It exercises the packaged terminal, file finder,
resource monitor, and server readiness in clean RHEL 8-compatible userspace.
Test the CLI with no host Node on `PATH`. A build on Ubuntu or an ELF scan alone
is insufficient. Keep failure logs. After kernel-dependent changes, verify on a
RHEL 8 or Rocky Linux 8 VM. If an update cannot meet this requirement, report the
conflict; do not remove checks or require the user to replace glibc.

## Keep upstream contributions clean

Use branch ancestry and separate commits to keep fork support out of upstream
PRs. File names, commit prefixes, and `.gitignore` do not remove changes from a PR.

- `main` is the fork integration and release branch, containing upstream plus
  fork support and selected product changes.
- `fork/<topic>` starts from fork `main` and targets fork `main`. Keep CI,
  installers, release routing, and policy changes in these commits. Use titles
  such as `chore(fork): configure GitHub release builds`.
- `contrib/<topic>` starts directly from a fetched `upstream/main` or an agreed
  upstream release and contains one upstream-suitable fix and its tests. Push
  it only to the fork. Never merge fork `main` into it.

Prefer implementing an upstream-suitable fix on a clean contribution branch,
then cherry-pick its commit into a fork integration branch. If a fix starts on
the fork, create a clean branch from upstream and cherry-pick only that fix.
Remove dependencies on fork behavior. Keep fork support and product fixes in
separate commits even when they edit the same file.

Before submission, fetch upstream and inspect `git log upstream/main..HEAD` and
`git diff upstream/main...HEAD`. Review the complete diff, including workflows,
policy, version metadata, URLs, and defaults. Do not rely on path exclusions.
Test the clean branch without fork configuration and follow current upstream
`CONTRIBUTING.md`, including required scope approval and evidence. Clean branches
retain upstream workflows; do not add fork CI just to run them on the fork.

Create no PR or push without the applicable maintainer request. All branch pushes
go to `MTVaught/t3code` after verifying the owner. Creating or updating an upstream
PR requires explicit user authorization. Permission to work on the fork, push a
fork branch, or prepare a contribution does not authorize an upstream PR. Other
upstream writes also require explicit authorization. Never push to upstream or
submit fork `main` as an upstream PR.

When updating upstream, review build, release, identity, and install-path changes
against this file. Drop a product patch once upstream provides the needed behavior.
See [the release guide](docs/operations/release.md) for commands and signing setup.
