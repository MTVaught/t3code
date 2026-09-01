# Bob ACP integration

Bob Shell 2.0.1 exposes a native Agent Client Protocol server through `bob acp`. T3 treats that
protocol as the integration boundary. The adapter does not parse `bob run` output, inspect Bob's
private database, scan Bob configuration files, calculate Bobcoins, stage attachments in the
workspace, or impose a Bob-specific tool ceiling.

## Architecture

`BobDriver` creates a thin `BobAdapter` around the shared `BasicAcpAdapter`. `BobAcpSupport` owns the
Bob-specific launch and ACP compatibility choices:

- command: `bob acp`
- authentication method: `sso`
- continuation: `session/resume`
- mode changes: `session/set_mode`

The generic adapter owns session lifecycle, permission projection, T3 MCP injection, image prompt
encoding, runtime events, and dynamic mode and command metadata. Provider-specific complexity stays
at the ACP launch boundary.

One ACP child and session remain alive for each active T3 thread. The adapter emits the ACP session
ID in its resume cursor as soon as session startup succeeds; `ProviderService` persists that cursor
from `session.started`, rather than waiting for the first completed turn. A restored thread starts a
new child and asks Bob to resume the persisted ACP session.

## Protocol mapping

| Bob ACP input or notification    | T3 behavior                                       |
| -------------------------------- | ------------------------------------------------- |
| `agent_message_chunk`            | assistant text delta                              |
| `agent_thought_chunk`            | reasoning text delta                              |
| `plan`                           | canonical turn plan                               |
| `tool_call` / `tool_call_update` | canonical tool lifecycle                          |
| `request_permission`             | T3 approval request or runtime-mode auto approval |
| `current_mode_update`            | persisted provider mode                           |
| `available_commands_update`      | project slash-command metadata                    |
| ACP image prompt content         | direct image attachment delivery                  |

Bob reports available modes during new or resumed session setup. Before a child exists, T3 advertises
Agent, Ask, and Plan plus the custom modes it reads from `~/.bob/settings/custom_modes.yaml` and the
workspace's `.bob/custom_modes.yaml` / `.bob/*/custom_modes.yaml` (`Drivers/BobModes.ts`), then
switches to Bob's authoritative list for the active workspace once a session reports it. Project metadata queries refresh while mounted, allowing web, desktop, and
mobile composers to pick up command and mode changes without a server restart.

## Deliberately unsupported capabilities

T3 advertises no Bob steering, rollback, structured user input, model switching, token usage, or
billing usage because Bob ACP 2.0.1 does not provide the corresponding protocol behavior. These are
capability decisions, not emulated fallbacks. Bob controls model routing, so T3 stores a hidden
`bob-managed` selection sentinel and never sends it to Bob.

The status probe requires Bob 2.0.1 or newer. Persisted legacy `premium` model selections remain
accepted for migration, but new threads use `bob-managed`. Obsolete one-shot Bob settings are
discarded when settings are decoded; only enablement and the optional binary path remain.

## Persistence

The `provider_mode` column on `projection_threads` is a fork-owned schema change and is deliberately
not a numbered migration. The Effect migrator skips every id at or below the highest recorded id, so a
fork-numbered migration collides with upstream's next migration of the same id, and a higher id would
block upstream migrations forever. `apps/server/src/persistence/ForkSchemaPatches.ts` applies the
column idempotently after each migration pass and deletes rows an earlier fork build recorded under a
numbered id, so upstream's migration with that id still runs on the next sync.
