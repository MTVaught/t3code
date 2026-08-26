# Install T3 Code

T3 Code is a web and desktop GUI for running coding agents on your machine.

## Requirements

Node.js `^22.16 || ^23.11 || >=24.10` on the machine that runs the T3 Code server.

At least one provider CLI, installed and authenticated. See [Providers](#providers) below.

## Run Without Installing

```bash
npx t3@latest
```

This starts the T3 Code server on your machine and opens the local web app. Use
`npx t3@latest --help` for the full CLI reference.

## Desktop App

Download the latest release from
[GitHub Releases](https://github.com/pingdotgg/t3code/releases), or install from a package
registry.

Windows:

```bash
winget install T3Tools.T3Code
```

macOS:

```bash
brew install --cask t3-code
```

Arch Linux:

Stable:

```bash
yay -S t3code-bin
```

### RHEL 8 and compatible distributions

The x86_64 AppImage supports RHEL 8 and compatible distributions such as Rocky Linux 8 and
AlmaLinux 8. On a minimal installation, install the desktop runtime libraries first:

```bash
sudo dnf install fuse-libs gtk3 nss alsa-lib libX11-xcb libdrm mesa-libgbm \
  libxkbcommon libXcomposite libXdamage libXrandr cups-libs at-spi2-atk xdg-utils
```

Then make the downloaded AppImage executable and run it:

```bash
chmod +x T3-Code-*-x86_64.AppImage
./T3-Code-*-x86_64.AppImage
```

Use the AppImage on RHEL 8. The direct `npx t3@latest` installation is not supported there because
some npm-distributed native dependencies require a newer system ABI.

Provider CLIs run as separate programs and must independently support RHEL 8.

Nightly:

```bash
yay -S t3code-nightly-bin
```

## Data location

Treher keeps its database and settings under `~/.t3-treher/userdata` by default. This is separate
from upstream T3 Code's `~/.t3/userdata`, so installing or running both applications cannot make
their database migrations collide. The desktop app also uses its own Electron profile, including
cookies and encrypted connection data. Treher does not automatically import upstream data.

## Providers

T3 Code drives provider CLIs; it does not ship them. Install the CLI for each provider you want
to use, then authenticate it.

| Provider   | CLI                                                   | Default binary | Log in with           |
| ---------- | ----------------------------------------------------- | -------------- | --------------------- |
| Codex      | [Codex CLI](https://developers.openai.com/codex/cli)  | `codex`        | `codex login`         |
| Claude     | [Claude Code](https://claude.com/product/claude-code) | `claude`       | `claude auth login`   |
| Cursor     | [Cursor CLI](https://cursor.com/cli)                  | `cursor-agent` | `agent login`         |
| Grok Build | [Grok Build CLI](https://x.ai/cli)                    | `grok`         | `grok login`          |
| OpenCode   | [OpenCode](https://opencode.ai)                       | `opencode`     | `opencode auth login` |
| IBM Bob    | [Bob Shell](https://bob.ibm.com/docs/shell/)          | `bob`          | Bob's sign-in flow    |

Codex and Claude are on by default. Cursor, Grok Build, and OpenCode are off by default; turn
them on in **Settings** → the provider's card when you want to use them.

Cursor is the one to watch: install Cursor CLI, which provides the `cursor-agent` binary that
T3 Code looks for, but authenticate with `agent login`, not `cursor-agent login`.

Run the login command on the machine running the T3 Code server, not on the device you browse
from.

### Binary Discovery

Each provider CLI must be on the server's `PATH`, or have an explicit binary path set in
**Settings** → the provider instance → **Binary path**. Use the explicit path when a version
manager or a non-standard install location keeps the CLI off the `PATH` of the shell that
started T3 Code.

### When Auth Is Needed

Provider auth is required before you start a session with that provider, not before you start
T3 Code. You can install T3 Code, open it, and add providers afterwards. A provider that is not
authenticated shows its status in **Settings** and fails at session start with the login command
to run.

For provider-specific setup, see [Codex](./providers-codex.md),
[Claude](./providers-claude.md), and [IBM Bob](./providers-bob.md).

## Next Steps

- [Permission modes](./permission-modes.md): how much T3 Code asks before acting
- [Remote access](./remote-access.md): connect from a phone, tablet, or another desktop
- [Keeping T3 Code in sync](./updating.md): client and server version skew
- [Running in the background](./background-service.md): Linux background service
