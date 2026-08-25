# IBM Bob

T3 Code supports Bob Shell 2.0.1 and newer through Bob's Agent Client Protocol (ACP) server. Install
Bob on the machine running the T3 server, run `bob` once to complete Bob's license and sign-in flow,
then enable **Bob** in T3 Code Settings. T3 invokes `bob` from the server process's `PATH` by
default; a provider instance can instead specify an explicit binary path.

Bob also requires each workspace to be trusted. Open Bob interactively in a project and choose its
trust level before starting a T3 thread there. T3 intentionally does not pass Bob's `--trust` or
`--accept-license` switches on a user's behalf.

If your Bob setup uses an API key, enter `BOB_API_KEY` on the Bob provider card in **Settings**.
T3 stores the value as a server secret, does not return it to the client after saving, and passes it
only to processes launched for that Bob provider instance.

Each active T3 thread owns a long-lived `bob acp` process and ACP session. T3 persists Bob's session
ID and uses ACP session resume after a T3 server restart. If Bob can no longer resume that session,
use **Start new Bob session** on the error. This preserves the T3 thread and workspace while starting
fresh provider context.

## Modes, commands, and skills

Bob reports its available modes over ACP. Agent, Ask, and Plan are available immediately; any modes
Bob reports for the current workspace replace that initial list. Modes can be changed between turns,
and Bob-originated mode changes are saved on the thread.

Bob can also advertise workspace slash commands while a session is running. T3 adds those commands
to the composer on web, desktop, and mobile. Literal `$skill-name` prompts continue to work as
provider-native input; Bob does not currently expose skill discovery separately over ACP.

Bob owns its native rules, hooks, trust settings, and provider configuration. T3 also injects its
workspace MCP endpoint through ACP, so Bob can use T3-provided tools alongside Bob's own MCP
configuration.

## Approvals and attachments

Bob sends tool permission requests to T3 through ACP. T3 applies the thread's runtime setting:

- **Supervised** asks before tool actions.
- **Auto-accept edits** and **Auto** approve edit, delete, and move actions; other actions still ask.
- **Full access** approves every offered action without prompting.

These decisions use the permission kinds and choices Bob offers. T3 does not launch Bob with its
global `--auto-approve` or `--trust` switches.

Image attachments are sent directly as ACP image content. They are not copied into the workspace.

## Current protocol boundaries

- A running Bob turn can be interrupted, but cannot accept a steered follow-up prompt.
- Bob ACP does not expose conversation rewind, so conversation **Revert** is unavailable for Bob.
- Bob ACP does not expose structured form input or token and billing usage to T3.
- Subagent and tool progress is displayed to the extent Bob reports it through ACP.

For Bob-side setup and project configuration, see the
[Bob Shell documentation](https://bob.ibm.com/docs/shell/).
