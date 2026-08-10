# IBM Bob

T3 Code supports IBM Bob Shell 2.x. Install Bob on the machine running the T3
server, verify that `bob` works from the environment used to launch the T3 server, complete Bob's
own sign-in and license flow there, then enable **Bob** in T3 Code
Settings. T3 invokes the `bob` binary by default; set an explicit binary path on the provider
instance if it is not on the server process's `PATH`.

For headless authentication, set **BOB_API_KEY** on the Bob provider instance. T3 passes the
configured value only to Bob subprocesses. Leave it blank to inherit `BOB_API_KEY` from the T3
server process environment instead.

Bob threads use Bob tasks for conversation continuity. T3 stores the task ID after each turn and
resumes it on the next turn, including after a server restart. If Bob's local task database no
longer contains that task, use **Start new Bob context** on the error. This keeps the T3 thread and
workspace but deliberately starts a fresh Bob conversation.

## Modes, commands, and skills

Choose the Bob mode in the thread composer. T3 lists Agent, Ask, and Plan together with custom
modes from Bob's global and workspace configuration. Workspace modes override global or built-in
modes with the same slug. New Bob threads start in Agent mode.

T3 passes the selected slug to Bob's supported `--mode` option and otherwise leaves project
behavior to Bob. Bob loads its own rules, trust configuration, custom modes, skills, hooks, and MCP
configuration. When Bob switches mode during a turn, T3 updates the thread selection so the next
turn resumes in that mode.

T3 sends prompt text unchanged. Literal `$skill-name` invocation remains provider-native. Bob's
headless interface does not currently expand interactive slash commands, and T3 does not emulate
that harness behavior.

## Usage and attachments

Bob usage is shown in **Bobcoins**, not US dollars. The displayed total is cumulative for the Bob
task; a last-turn delta appears when T3 can derive one safely. Public token counters are shown when
Bob reports them.

Image attachments are copied into a temporary folder inside the selected workspace so Bob can
inspect them. T3 removes that staging folder before it records the completed turn checkpoint.

## Headless limitations

- Bob cannot ask for interactive approvals or structured form input in headless mode. T3 enforces
  its runtime setting by disabling Bob tool groups before the task starts.
- A running Bob turn cannot be steered. Interrupting sends SIGINT to that exact Bob process and T3
  retains any final resumable task ID Bob emits while shutting down.
- Bob's public CLI cannot rewind or fork a task. Conversation **Revert** is therefore unavailable
  for Bob and the server rejects it before restoring files.
- Bob-native MCP configuration continues to work. T3's provider-injected workspace MCP is not
  passed to Bob.
- Bob reports parent subagent start and result events, but not live child progress. T3 shows only
  the information Bob actually exposes.

For Bob-side setup and project configuration, see the
[Bob Shell documentation](https://bob.ibm.com/docs/shell/).
