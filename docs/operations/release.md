# Release Checklist

> For maintainers. Using T3 Code? See [docs/user](../user/).

This document covers the fork's unified release workflow for stable and nightly desktop
releases and the CLI archives that ship with them. Upstream's pipeline also publishes to npm and
AUR, deploys the hosted web app, marketing site, and relay, and announces on Discord; none of that
runs here (see [What the fork skips](#what-the-fork-skips)).

## Fork release numbering

Fork releases preserve the complete upstream version in the SemVer core and add the fork's release
sequence as prerelease identifiers:

```text
v<upstream-version>-treher.<fork-release>.<phase>[.rc.<candidate>]
```

- `<upstream-version>` is the upstream release tag on which the fork is based, without the leading
  `v`. Use the actual tagged base, not the latest upstream release at the time the fork ships.
- `<fork-release>` starts at `1` for each upstream base and increments for subsequent fork releases
  based on that same upstream version.
- `<phase>` is `0` for release candidates and `1` for the final release.
- `<candidate>` starts at `1` and increments for each release-candidate build.

For example, the first release candidate based on upstream `v0.0.32` is
`v0.0.32-treher.1.0.rc.1`, followed by the final `v0.0.32-treher.1.1`. A second fork release from
the same upstream base starts at `v0.0.32-treher.2.0.rc.1`. After adopting upstream `v0.0.33`, the
fork sequence resets, beginning with `v0.0.33-treher.1.0.rc.1`.

Keep the numeric phase even though `rc` already identifies a candidate. It ensures SemVer orders the
final release after all of its candidates. The `treher` identifier also prevents fork tags from
colliding with upstream tags.

## What the workflow does

- Workflow: `.github/workflows/release.yml`
- Triggers:
  - push tag matching `v*.*.*` for a stable release of the tagged commit
  - manual `workflow_dispatch` with `channel=stable` and a `version` input, building the
    dispatched commit
  - every push to `main` publishes a nightly
  - manual `workflow_dispatch` with `channel=nightly`
- Nightly and stable runs use separate concurrency groups. Runs in a group queue behind each
  other and are never canceled, so overlapping `main` pushes cannot publish out of order.
- Runs lint, typecheck, and tests alongside artifact builds. Server tests are sharded over
  separate runners (`quality_server`). Publishing waits for every check.
- Does not read T3 Connect relay or Clerk configuration: the fork removed upstream's
  `relay_public_config` job, so builds point at no relay unless you export `T3CODE_RELAY_URL` and
  `T3CODE_CLERK_*` on the `build_bundle` job yourself.
- Builds the platform-independent JS (server bundle, web client, Electron main) once in the
  `build_bundle` job and hands it to every platform job as the `js-bundle` artifact; the platform
  jobs only package it (`--skip-build`), so no runner rebuilds it.
- Builds the Linux native components (node-pty, resource monitor, fff) on Rocky Linux 8 in
  `build_linux_native` so the AppImage keeps the RHEL 8 / glibc 2.28 ABI floor.
- Builds three desktop artifacts in parallel for both channels (the `build` matrix on GitHub-hosted
  runners):
  - macOS `arm64` DMG
  - Linux `x64` AppImage (stages the RHEL 8 prebuilds; `npmRebuild` is off so packaging cannot
    raise the glibc floor)
  - Windows `x64` NSIS installer (embeds the Linux `x64` CLI archive as its WSL runtime)
- Builds a self-contained CLI archive per target and attaches them to the GitHub Release with a
  `SHA256SUMS` file, on both channels: `t3-<version>-darwin-arm64.tar.gz` and
  `t3-<version>-win32-x64.zip` in the same matrix job as that target's desktop artifact, and
  `t3-<version>-linux-x64.tar.gz` in its own `build_linux_cli` job, because the Windows job embeds
  it and a matrix entry cannot depend on a sibling. Every archive is built, signed, and
  smoke-tested on hardware of its own architecture.
  - The archive holds the server as a Node single-executable (`scripts/build-cli-archive.ts`), so
    unpacking it needs neither Node, npm, nor a compiler. It is the only form in which T3 Code
    manages a runtime: the desktop's SSH environments, the boot service, `t3 update`, and the
    install scripts (`scripts/install.sh`, `scripts/install.ps1`) all download and verify this
    archive against `SHA256SUMS` from this fork's GitHub Releases
    (`packages/shared/src/cliRelease.ts`, overridable with `T3CODE_RELEASE_BASE_URL`).
  - The executable is built with a Node that supports `--build-sea` (`VP_NODE_VERSION=26.8.2`,
    kept in step with `SEA_NODE_VERSION` in `apps/server/vite.config.ts`), while the repo stays on
    `engines.node`.
  - macOS archives are signed with the Developer ID certificate and notarized when the Apple
    secrets are present (ad hoc otherwise, which still runs from `curl`/`tar` installs). Windows
    executables use the same Azure Trusted Signing setup as the installer.
  - Each archive is extracted and executed on its build runner (`scripts/smoke-cli-archive.ts`)
    before it is uploaded.
  - The Linux archive's node-pty is compiled by `vp install --prod` on the Ubuntu runner, so the
    archive's glibc floor is that runner's, not RHEL 8's. Only the AppImage carries the RHEL 8
    guarantee.
- Before publishing, extracts the Linux AppImage on Rocky Linux 8, rejects any packaged ELF above
  GLIBC 2.28, exercises the terminal, resource monitor, and file finder, and verifies that the
  desktop shell starts its bundled server and creates the main window.
- Publishes one GitHub Release with all produced files.
  - Stable tags with a suffix after `X.Y.Z` (for example `1.2.3-alpha.1`) are published as GitHub prereleases.
  - Only plain stable `X.Y.Z` releases are marked as the repository's latest release.
  - Nightly runs are always GitHub prereleases and never marked latest.
  - Automatically generated release notes are pinned to the previous tag in the same channel, so stable compares to the previous stable tag and nightly compares to the previous nightly tag.
- Includes Electron auto-update metadata (for example `latest*.yml`, `nightly*.yml`, and `*.blockmap`) in release assets.
- Publishes the release with the built-in `GITHUB_TOKEN`; no Release App or npm credentials are
  involved.
- Signing is optional and auto-detected per platform from secrets.

## What the fork skips

Upstream's `release.yml` also has `resolve_commit`, `relay_public_config`, `publish_cli`,
`publish_aur`, `deploy_web`, `deploy_marketing`, `finalize`, and `announce_discord` jobs, a
`preview` channel, macOS `x64` and Linux/Windows `arm64` targets, Blacksmith runners, and the
`release-desktop.yml` reusable workflow. The fork has none of these:

- The `t3` npm launcher and `@t3code/t3-<platform>-<arch>` packages are not published. `npx t3`
  resolves upstream's packages, not this fork's; use the install scripts or a release archive.
- `packages/shared/src/cliRelease.ts` lists five archive platforms but the fork builds three.
  `t3 update`, the install scripts, and desktop runtime installs 404 on `linux-arm64` and
  `win32-arm64` hosts.
- No hosted web app or marketing site deploys, no relay deploy, no AUR package, no Discord post,
  and no version bump commit back to `main`.

## Pull request macOS previews

Labeling a same-repo PR `preview:mac` runs `.github/workflows/desktop-macos-preview.yml`: one
workflow that builds an unsigned Apple Silicon DMG on a GitHub-hosted macOS runner, uploads it to
the rolling `desktop-preview` prerelease, comments the download link on the PR, and removes the
download when the PR closes or loses the label. Upstream split this into an untrusted bundle build
plus a trusted signing half (`desktop-macos-preview-publish.yml` over `release-desktop.yml`); the
fork keeps the single unsigned workflow.

## Required release credentials

Releases publish with the repository-scoped `GITHUB_TOKEN` (`contents: write` on the `release`
job). The only other credentials are the optional platform signing secrets below. Upstream's
`RELEASE_APP_ID` / `RELEASE_APP_PRIVATE_KEY`, Vercel, Cloudflare, PlanetScale, Axiom, and npm
trusted publishing are not used.

## Nightly builds

- Workflow: `.github/workflows/release.yml`
- Triggers:
  - every push to `main`
  - manual `workflow_dispatch` with `channel=nightly`
- There is no schedule and no publication-gap check; every `main` push is a nightly. Nightly runs
  are serialized by the `release-nightly` concurrency group and never canceled.
- Runs the same desktop quality gates, artifact matrix, and CLI archive jobs as the tagged release flow.
- Publishes a GitHub prerelease only:
  - current tag format: `vX.Y.Z-nightly.YYYYMMDD.<run_number>`
  - `nightly-v...` is accepted only as a legacy previous-nightly tag
  - release name includes the short commit SHA
  - `make_latest` is always `false`
- Uses the next stable patch version as the nightly base. For example, `0.0.17` produces nightlies on `0.0.18-nightly.*`.
- Publishes Electron auto-update metadata to the dedicated `nightly` updater channel, so desktop users can opt into that track independently from stable.
- Attaches the same CLI archives and `SHA256SUMS` as a stable release, so `t3 update --channel nightly` and nightly desktop builds can install the matching runtime.
- Does not commit version bumps back to `main`.

## Server self-update release invariant

Connected servers update to the client's exact version, not to a channel. Every released desktop
version must therefore have its CLI archives attached to the same GitHub Release before users can
receive that client: the **Update server** action, the boot service, SSH environments, and
`t3 update` all download `t3-<version>-<platform>-<arch>.tar.gz` (`.zip` on Windows) from
`https://github.com/MTVaught/t3code/releases/download/v<version>/` and verify it against
`SHA256SUMS`.

The workflow enforces this ordering:

1. `build_linux_cli` and the `build` matrix produce the archives (`cli-*` artifacts) next to the
   desktop artifacts.
2. `release` downloads both, writes `SHA256SUMS` from the exact bytes it uploads, and publishes
   everything in one GitHub Release. The updater manifests are part of that same upload, so no
   desktop can be offered a version whose archives are missing.

Preserve these dependencies when changing the release graph. A release without archives leaves the
**Update server** action targeting a download that does not exist.

For a release smoke test, download `SHA256SUMS` from the release and confirm it lists an archive
for each of the three targets, then connect the new client to a server on the previous version
and verify that the update action reconnects to the matching server. When the release adds
database migrations, verify that the remote update applies them and reconnects. A failed trial
must restore the database snapshot and restart the previous server. If the installed launcher
does not support the target protocol, verify that the update stops before restart and run
`t3 service update` once on the server machine from a freshly extracted archive.

## Desktop auto-update notes

- Updater runtime: `apps/desktop/src/updates/DesktopUpdates.ts`.
- `electron-updater` adapter: `apps/desktop/src/electron/ElectronUpdater.ts`.
- `apps/desktop/src/main.ts` only wires the updater layers into the desktop runtime.
- Update UX:
  - Background checks run on startup delay + interval.
  - No automatic download or install.
  - The desktop UI shows a rocket update button when an update is available; click once to download, click again after download to restart/install.
- Provider: GitHub Releases (`provider: github`) configured at build time.
- Repository slug source:
  - `T3CODE_DESKTOP_UPDATE_REPOSITORY` (format `owner/repo`), if set.
  - otherwise `GITHUB_REPOSITORY` from GitHub Actions.
- Required release assets for updater:
  - platform installers (`.exe`, `.dmg`, `.AppImage`, plus macOS `.zip` for Squirrel.Mac update payloads)
  - channel metadata: `latest*.yml` for stable releases, `nightly*.yml` for nightly releases
  - `*.blockmap` files (used for differential downloads)
- macOS metadata note:
  - `electron-updater` reads `latest-mac.yml` on stable and `nightly-mac.yml` on nightly, for both Intel and Apple Silicon.
  - The workflow merges the per-arch mac manifests into one channel-specific mac manifest before publishing the GitHub Release.

### Windows payload topology and update validation

Windows packages the bundled server and only its runtime-external/native
dependency closure in `resources/server.asar`. Native modules and helper
executables declared as unpacked by that archive must be present at the matching
paths below `resources/server.asar.unpacked`. The Windows-native backend reads
the archive in place through Electron. Packaged Windows builds also ship
`resources/wsl-runtime.tar.gz` plus its SHA-256 sidecar: the Linux CLI archive
(`t3-<version>-linux-x64.tar.gz`) built by `build_linux_cli` and handed to the
Windows desktop build as `--wsl-runtime`, copied in verbatim so WSL runs the
exact bytes a Linux user downloads. WSL verifies and extracts that archive
into `~/.t3/wsl-runtime/sha256-<archive-digest>` inside the selected
distro, then reuses it for later launches of the same update.

Windows keeps JavaScript and package metadata inside `app.asar` and unpacks only
native libraries and helper executables. Avoid enabling whole-package smart
unpacking: each loose file adds work to NSIS installation and counts against
the payload limit.

The artifact builder rejects a Windows package when any of these invariants
break:

- `resources/server.asar` is absent or does not contain the server entry.
- Any file marked unpacked in the ASAR header is absent from
  `resources/server.asar.unpacked`.
- On same-architecture Windows builds, the packaged primary cannot load the fff
  native library from inside `server.asar` through its `.unpacked` sibling.
- The isolated, extracted sidecar cannot load the server entry with plain Node.
- A Windows build given `--wsl-runtime` omits the WSL archive or SHA-256
  sidecar, or the sidecar digest does not match the emitted archive.
- The emitted WSL archive is not a Linux CLI release archive: it must unpack to
  a single `t3-<version>-linux-<arch>` directory holding `t3`, `client/`, and
  `node_modules/` with the Linux node-pty binary, and must not carry a loose
  server bundle (`bin.mjs`).
- The external Windows resource monitor is absent.
- The unpacked Windows application contains more than 80 files.

Cross-architecture Windows builds retain every structural and extracted-sidecar
check, but skip executing the target Electron binary. A same-architecture build
for each release target must exercise the primary native-load probe.

NSIS differential packaging remains enabled. A sidecar layout transition can
produce a larger one-time download; subsequent small releases retain their
blockmaps, with a 60 MB maximum for a representative sidecar-to-sidecar update.

## 0) CLI archive setup

Nothing to configure: the archives are built from the same checkout and signed with the platform
secrets below. Two knobs matter:

- `packages/shared/src/cliRelease.ts` pins the download repository (`MTVaught/t3code`) and the
  archive platform list. Change both together with the workflow: a key without a build 404s, a
  build without a key is unreachable from every installer.
- `T3CODE_RELEASE_BASE_URL` overrides the download origin at runtime for mirrors and air-gapped
  installs; it must serve `v<version>/<archive>` and `v<version>/SHA256SUMS`.

## 1) Release validation and unsigned builds

There is no dry-run tag path. Pushing any accepted non-nightly tag, including
`v0.0.0-test.1`, classifies the run as the stable channel and creates a real GitHub Release with
updater manifests and CLI archives. Do not push a test tag to validate the workflow.

The workflow has no non-publishing `workflow_dispatch` mode. Use normal CI or local quality gates to
validate checks and builds without shipping. To exercise the complete release graph at lower stable
risk, manually dispatch `channel=nightly`; this still publishes a real GitHub prerelease with
desktop updater metadata and CLI archives on the nightly channel. Only run it when a real nightly
release is acceptable.

Manual `channel=stable` with a version input is also a real stable-channel release. Omitting signing
secrets only makes platform artifacts unsigned; it does not prevent publication.

## 2) Apple signing + notarization setup (macOS)

Required secrets used by the workflow:

- `CSC_LINK`
- `CSC_KEY_PASSWORD`
- `APPLE_API_KEY`
- `APPLE_API_KEY_ID`
- `APPLE_API_ISSUER`

Checklist:

1. Apple Developer account access:
   - Team has rights to create Developer ID certificates.
2. Optionally register the explicit App ID `dev.treher.t3code` to reserve it in the developer team;
   no capabilities are required.
3. Create a `Developer ID Application` certificate.
4. Export the certificate + private key as `.p12` from Keychain.
5. Base64-encode the `.p12` and store it as `CSC_LINK`.
6. Store the `.p12` export password as `CSC_KEY_PASSWORD`.
7. In App Store Connect, create an API key (Team key).
8. Add API key values:
   - `APPLE_API_KEY`: contents of the downloaded `.p8`
   - `APPLE_API_KEY_ID`: Key ID
   - `APPLE_API_ISSUER`: Issuer ID
9. Re-run a tag release and confirm the macOS artifacts are signed and notarized.

Notes:

- `APPLE_API_KEY` is stored as raw key text in secrets.
- The workflow writes it to a temporary `AuthKey_<id>.p8` file at runtime.
- The macOS CLI archive uses the same `CSC_LINK` certificate (imported into a throwaway keychain)
  and the same API key for notarization. Without them the archive is signed ad hoc, which still
  runs from a `curl | tar` install but not from a quarantined download.

## 3) Azure Trusted Signing setup (Windows)

Required secrets used by the workflow:

- `AZURE_TENANT_ID`
- `AZURE_CLIENT_ID`
- `AZURE_CLIENT_SECRET`
- `AZURE_TRUSTED_SIGNING_ENDPOINT`
- `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME`
- `AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME`
- `AZURE_TRUSTED_SIGNING_PUBLISHER_NAME`

Checklist:

1. Create Azure Trusted Signing account and certificate profile.
2. Record ATS values:
   - Endpoint
   - Account name
   - Certificate profile name
   - Publisher name
3. Create/choose an Entra app registration (service principal).
4. Grant service principal permissions required by Trusted Signing.
5. Create a client secret for the service principal.
6. Add Azure secrets listed above in GitHub Actions secrets.
7. Re-run a tag release and confirm the Windows installer and the `t3.exe` inside the Windows
   CLI archive are signed.

## 4) Ongoing release checklist

1. Ensure `main` is green in CI and verify its latest nightly with the smoke test above.
2. Choose the next tag using the [fork release numbering](#fork-release-numbering), then either
   push that `vX.Y.Z-treher...` tag or dispatch the Release workflow with `channel=stable` and the
   version as the `version` input.
3. Verify workflow steps:
   - preflight passes
   - release quality checks pass
   - `build_bundle`, `build_linux_native`, `build_linux_cli`, and all matrix builds pass
   - the RHEL 8 verification passes
   - release job uploads the installers, updater manifests, three CLI archives, and `SHA256SUMS`
4. Smoke test downloaded artifacts.

## 5) Troubleshooting

- macOS build unsigned when expected signed:
  - Check all five Apple signing secrets are populated and non-empty.
  - Confirm the `.p12` contains a Developer ID Application certificate and its private key.
- Windows build unsigned when expected signed:
  - Check all Azure ATS and auth secrets are populated and non-empty.
- Build fails with signing error:
  - Retry with secrets removed to confirm unsigned path still works.
  - Re-check certificate/profile names and tenant/client credentials.
