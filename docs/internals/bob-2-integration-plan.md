# Bob 2.0 integration plan

This plan replaces the Bob 1 adapter with a complete Bob 2 integration built on
Bob's public headless interface. It was checked against T3 Code's current
provider, orchestration, settings, web, and mobile implementations and against
an installed Bob `2.0.0` (`7a5dcab1`). The CLI behavior below was exercised
directly; it is not inferred from `--help` text.

## Verified Bob 2 behavior

These observations are implementation requirements, not expectations:

| Flow                    | Observed behavior                                                                                                                                                                                        | Consequence for T3                                                                                                                                                                                 |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Basic run               | `bob run --format stream-json --workspace <cwd> --mode <mode> <prompt>` emits NDJSON and exits successfully.                                                                                             | Replace the Bob 1 invocation and parser completely.                                                                                                                                                |
| Streaming text          | Assistant `message.content` arrives as small deltas. The user's prompt is also echoed as a `message`.                                                                                                    | Ignore echoed user messages and append assistant deltas.                                                                                                                                           |
| Final output            | `--format json` returned one `result` with `last_message`; `stream-json` results did not consistently include `last_message`.                                                                            | Chat must assemble deltas and reconcile `last_message` only when present. One-shot text generation can use `json`.                                                                                 |
| Reasoning               | Bob's stream renderer emits `message.isReasoning` when the model marks a chunk as reasoning.                                                                                                             | Map reasoning and answer text to separate canonical content streams.                                                                                                                               |
| Tool events             | Bob emits `tool_use` and `tool_result`, but a result can appear without a visible preceding use. Tool IDs can be very large opaque strings.                                                              | Accept orphan results and keep Bob IDs internal; derive bounded T3 IDs rather than putting unbounded IDs on the wire.                                                                              |
| Errors                  | The same error can be emitted more than once. Limit failures can be followed by `result.status = "success"`.                                                                                             | Deduplicate errors and give an observed error or T3 interruption precedence over a success result.                                                                                                 |
| Missing resume task     | Resuming a nonexistent 32-character task ID exited `1` with plain stderr and no NDJSON: `No task found with id ...`.                                                                                     | Startup and pre-stream failures must be parsed from bounded stderr and classified separately.                                                                                                      |
| Resume                  | A completed task resumed successfully and retained an earlier codeword. The result task ID is 32 lowercase hexadecimal characters, not a UUID.                                                           | Persist Bob task IDs as opaque validated strings and use `--resume <id>`.                                                                                                                          |
| Cancellation            | Sending Ctrl-C during a turn caused Bob to emit a final success result with a task ID and exit `0`.                                                                                                      | Send SIGINT, drain output, retain the cursor and usage, but keep the T3 turn interrupted.                                                                                                          |
| Bobcoins                | A normal resumed result reported the task's cumulative `session_costs`, not just that invocation's usage.                                                                                                | Persist a usage baseline and compute per-turn deltas. Never put the value in `totalCostUsd`.                                                                                                       |
| Cost-limit failure      | A task already at `0.013582` Bobcoins run with `--max-cost 0.001` emitted an error reporting the cumulative cost, then a success result whose `session_costs` was `0`. The database retained `0.013582`. | Stream cost is not monotonic on every terminal path. Prefer a feature-detected database snapshot when available and never replace a higher persisted cumulative total with a lower terminal value. |
| Cost threshold          | A fresh task with `--max-cost 0.001` completed at `0.00847` Bobcoins.                                                                                                                                    | `--max-cost` is a task-level soft stopping threshold, not a hard cap or a per-turn budget. Label it accurately.                                                                                    |
| Tokens                  | Production stream results contained no token fields. `~/.bob/db/bob.db` stored cumulative `input`, `output`, `cacheRead`, `cacheWrite`, `cost`, and `contextTokens` in `tasks.costs`.                    | Token reporting needs an optional, read-only private-database fallback and must degrade cleanly.                                                                                                   |
| Maximum turns           | With `--max-turns 1`, Bob made two successful file writes in one inference turn, emitted a maximum-turn error, then emitted a success result.                                                            | Turns are not tool calls. Preserve completed tools, then fail the turn because of the error.                                                                                                       |
| Plan mode               | Native Plan mode used `write_file` successfully. Its observed groups included `edit`, `mcp`, `skill`, and `subagent`.                                                                                    | Plan is not read-only. T3 runtime safety restrictions must be applied independently of Bob mode.                                                                                                   |
| Ask mode                | Ask mode did not edit, but its native groups still included MCP, skills, and subagents.                                                                                                                  | Ask is not a sufficient external-side-effect boundary. Apply T3 restrictions independently.                                                                                                        |
| Tool-group restrictions | Disabling `edit` prevented file writes; disabling `execute` prevented commands.                                                                                                                          | `--disable-tool-groups` is the enforcement mechanism for T3 runtime modes.                                                                                                                         |
| Structured input        | When told to use an interactive question tool, Bob stated that none was available and asked in ordinary assistant text.                                                                                  | Bob has no structured user-input flow in headless mode.                                                                                                                                            |
| Custom mode             | A workspace `.bob/custom_modes.yaml` mode was selected by arbitrary slug and its instructions were applied.                                                                                              | Support arbitrary Bob mode slugs, not an enum.                                                                                                                                                     |
| Rules                   | Workspace `AGENTS.md` instructions were loaded in headless mode.                                                                                                                                         | Continue to let Bob own its rules and context loading.                                                                                                                                             |
| Skill                   | Sending `$probe-skill` caused a real `use_skill` call and loaded `.bob/skills/probe-skill/SKILL.md`, including in Ask mode.                                                                              | Literal skill insertion works and should remain provider-native.                                                                                                                                   |
| Slash command           | Sending `/probe-command VALUE77` to `bob run` did **not** perform native command expansion. Bob eventually reported that the command was unrecognized.                                                   | Preserve the literal prompt. T3 must not reimplement Bob harness features; slash expansion remains unavailable until Bob exposes it through the headless interface.                                |
| Native MCP              | A workspace `.bob/mcp.json` server was listed by `bob mcp list` and its tool was called from `bob run`. `--disable-mcp` removed it.                                                                      | Preserve Bob-native MCP. It is distinct from T3 MCP injection.                                                                                                                                     |
| Subagent                | The parent emitted a `spawn_subagent` tool use and later one `<task_result>` tool result. Bob stored a child task internally, but no child tool progress appeared in the parent stream.                  | Represent start/completion only and do not fabricate live progress.                                                                                                                                |
| Image in workspace      | Bob displayed and understood an image within `--workspace`.                                                                                                                                              | Bob itself supports image input.                                                                                                                                                                   |
| Image outside workspace | A direct path outside the workspace was blocked. A link inside the workspace to the same persisted image was readable; a copied image was also readable.                                                 | T3 attachments are supportable by staging a bounded copy inside the workspace for the turn. The earlier “attachments unsupported” conclusion was wrong.                                            |
| API-key compatibility   | Bob 2 worked with current `BOB_API_KEY`. The installed build also accepted legacy `BOBSHELL_API_KEY`.                                                                                                    | Emit `BOB_API_KEY`; preserve ambient legacy compatibility during migration.                                                                                                                        |

Bobcoins are IBM's billing unit, not a field denominated in USD. IBM currently
documents a conversion of one Bobcoin to USD, but also describes Bobcoins as an
abstraction over model/token cost. T3 should display Bobcoins as the billing
truth and should not calculate a USD charge. See [Bobcoins](https://bob.ibm.com/docs/ide/account/bobcoins).

## Corrected architecture decisions

### 1. Separate execution capabilities from client presentation

`ProviderAdapterCapabilities` in
`apps/server/src/provider/Services/ProviderAdapter.ts` is currently an internal
server contract containing only `sessionModelSwitch`. Its only meaningful
consumer is provider command orchestration. Adding Bob booleans there does not
make web or mobile respect them.

Client-visible provider metadata is `ServerProvider` in
`packages/contracts/src/server.ts`. It currently carries presentation fields,
models, slash commands, and skills. Implement two related layers:

1. Extend internal adapter capabilities for server-side enforcement:
   - conversation rollback
   - mid-turn steering
   - interactive approvals
   - structured user input
   - T3 MCP injection
   - attachments
   - session model switching
2. Add a forward-compatible client capability object to `ServerProvider` for:
   - model picker visibility
   - attachments
   - approvals and structured input
   - steering
   - rollback
   - provider modes
   - commands and skills
   - subagent progress level
   - token and billing usage

Use decoding defaults so older servers and clients remain compatible. Define
one Bob capability constant and use it to construct both representations so
they cannot drift.

Bob's final capability declaration is:

- provider-managed model: supported, but not user-selectable
- image attachments: supported through T3 staging
- interactive approvals: unsupported
- structured user input: unsupported
- mid-turn steering: unsupported
- conversation rollback: unsupported
- live subagent progress: unsupported; start/result summary supported
- T3 MCP injection: unsupported
- native Bob MCP: supported
- arbitrary Bob mode slug through instance configuration: supported
- project command/mode/skill discovery and slash-command autocomplete: unsupported because Bob exposes no structured headless metadata interface
- Bobcoin and best-effort token usage: supported

### 2. Keep one routing model even though Bob manages its model

T3 currently chooses a provider through `ModelSelection`: provider pickers are
model pickers grouped by provider instance. A provider with an empty model list
becomes effectively unselectable. Therefore “hide model selection” cannot mean
publishing zero Bob models.

Keep one non-custom routing model for Bob, hide model customization and the
model picker through provider presentation capability, and never pass the slug
to Bob. Retaining the legacy `premium` slug as an internal routing sentinel is
the least disruptive option for persisted threads and client settings; display
it as “Bob managed” and document that it is not a model/tier request.

`ProviderInstanceCard` currently renders `ProviderModelsSection` for every
known driver and directly reads `customModels` from the opaque instance config.
Add driver/provider presentation metadata to suppress that section for Bob;
removing `customModels` from the schema alone will not hide it.

### 3. Use Bob 2 settings only

`ServerSettings.providerInstances[*].config` is `Schema.Unknown`. The instance
registry decodes it through `BobDriver.configSchema`. Bob 1 compatibility is
intentionally unsupported; decode only the Bob 2 configuration:

```ts
{
  schemaVersion: 2,
  enabled: boolean,
  binaryPath: string,
  apiKey: string,
  teamId?: string,
  defaultMode: string,
  taskCostThresholdBobcoins?: number,
  maxTurns?: number,
  toolAccessCeiling: "read-only" | "edits" | "full"
}
```

Defaults are explicit and safe. Emit configured credentials as `BOB_API_KEY`;
when no configured key exists, inherit Bob's current environment behavior.

The access ceiling is necessary for a safe migration. Today Bob's default
provider setting is `auto_edit`, while T3's default thread runtime mode is full
access and the old adapter ignores that runtime mode. Removing the provider
setting without a ceiling would silently grant command execution to existing
Bob users. The UI must display the effective intersection of the thread runtime
mode and this instance ceiling.

Also require Bob major version 2 in `checkBobProviderStatus`. `bob --version`
currently prints a version and commit on separate lines. A 1.x or unknown-major
binary should produce a specific incompatible-version status. Never pass
`--accept-license` automatically.

### 4. Rebuild both Bob runtime paths

The chat adapter is not the only Bob 1 caller. `BobTextGeneration.ts` separately
uses the old `-p`, `-o`, `-m`, `--chat-mode`, `--max-coins`, and
`attempt_completion` protocol for thread titles, branch names, commit messages,
and PR content. A complete migration must replace both paths.

Chat invocation:

```text
bob run
  --format stream-json
  --workspace <cwd>
  --mode <bob-mode>
  [--resume <task-id>]
  [--team-id <id>]
  [--max-cost <bobcoins>]
  [--max-turns <count>]
  [--disable-mcp]
  [--disable-subagents]
  [--disable-tool-groups <groups>]
  <prompt>
```

Text-generation invocation should use `bob run --format json --mode ask`, with
all mutating and external tool groups disabled, no resume cursor, no T3 MCP,
and a bounded timeout/output. Parse `result.last_message`, extract the requested
JSON object, and validate it with the existing operation schema. It will create
a Bob task and consume Bobcoins; that should be documented rather than hidden.

Remove every Bob 1 concept:

- `init`
- UUID session IDs
- `attempt_completion`
- top-level `-p`
- `-o stream-json`
- `--chat-mode`
- `--yolo` and old approval flags
- `-m` and synthetic tiers
- `--max-coins`

### 5. Implement a bounded Bob 2 decoder

Decode the known `message`, `tool_use`, `tool_result`, `error`, and `result`
shapes while retaining forward compatibility with unknown fields and event
types. Required behavior:

- use server-generated event timestamps and bounded canonical IDs
- ignore echoed user messages
- append assistant text deltas
- map `isReasoning` to reasoning content
- support orphan tool results
- hash or otherwise derive short stable T3 item/task IDs from Bob's potentially
  huge IDs; retain raw IDs only in bounded in-memory correlation maps
- cap an individual line, the carry buffer, stderr tail, malformed-line sample,
  tool output, and final-message reconciliation input
- deduplicate repeated errors by stable severity/message identity
- require a valid terminal result for normal success; an exit-zero process with
  no result is malformed, not completed
- let any observed error or T3 interruption override result success
- capture task ID, duration, tool count, Bobcoins, and optional public tokens
- reconcile `last_message` only when it is present and extends or replaces a
  provably incomplete stream; never duplicate streamed content
- classify plain-stderr failures before the first NDJSON event, including
  missing task, authentication, license, invalid mode, and invalid arguments

### 6. Persist terminal resume state through the exact emitter

Bob's task ID first appears in the final result, so `sendTurn` must return the
T3 turn ID immediately without waiting for it.

On a terminal result the adapter must:

1. parse and validate the Bob task ID
2. read the best available cumulative usage snapshot
3. update its in-memory `ProviderSession.resumeCursor`
4. emit token/billing events
5. emit the terminal turn event last

Use a versioned opaque cursor, for example:

```ts
{
  version: 1,
  taskId: string,
  cumulativeUsage?: {
    bobcoins?: number,
    inputTokens?: number,
    outputTokens?: number,
    cacheReadTokens?: number,
    cacheWriteTokens?: number
  }
}
```

`ProviderService.processRuntimeEvent` currently only correlates and publishes.
On an accepted terminal event, it must query the **same adapter object that
emitted the event**, find that thread's latest session, and update the durable
session directory before publishing completion. Looking the adapter up again
by instance ID can race an instance rebuild and snapshot the wrong object.
Persistence failure must be logged and surfaced without killing the provider's
event subscription.

Tests must cover first-turn persistence, reconstruction in a new adapter/server
instance, cursor retention after graceful cancellation, and the plain-stderr
missing-task failure. The UI should offer a clear “start a new Bob context”
recovery path rather than silently retrying without conversation context.

### 7. Project Bobcoin and token usage end to end

Adding `billingUsage` only to `turn.completed` is insufficient. T3 currently
does not project `totalCostUsd` into a user-visible read model. Token UI is fed
by `thread.token-usage.updated`, which becomes a persisted
`context-window.updated` activity.

Add a provider-neutral billing snapshot/event and project it to a persisted,
hidden thread activity (or an equivalent typed turn-usage read model) consumed
by web and mobile. Keep billing separate from tokens:

```ts
{
  unit: "bobcoin",
  cumulativeAmount: number,
  turnAmount?: number
}
```

For tokens, emit `thread.token-usage.updated` and extend
`ThreadTokenUsageSnapshot` with cache-write tokens. Map Bob's cumulative values
as follows:

- `contextTokens` -> `usedTokens`
- `input` -> `totalProcessedTokens`/cumulative input metadata as appropriate
- `output` -> cumulative output
- `cacheRead` -> cumulative cached input
- `cacheWrite` -> new cumulative cache-write field
- deltas from the previous cursor -> `last*` fields
- result duration and tool count -> `durationMs` and `toolUses`

Do not publish a context percentage because Bob supplies no trustworthy context
maximum.

Usage source order:

1. optional public result fields, if a future Bob build emits them
2. a read-only query of Bob's private task database keyed by exact task ID
3. `stats.session_costs` as a Bobcoin-only fallback

The database reader must resolve the Bob home from the exact child environment,
account for Bob's `db/bob.db` versus development `dev-db/bob.db`, open SQLite
read-only with a short busy timeout, inspect the table/column before querying,
validate every JSON number, and never fail a successful Bob turn. Treat totals
as monotonic: on the observed max-cost error the stream regressed to zero while
the database remained correct.

Display “Bobcoins,” current context tokens, cumulative input/output/cache-read/
cache-write tokens, and last-turn deltas. Do not display the amount as USD and
do not hard-code a USD conversion into billing UI.

### 8. Keep Bob mode and T3 safety orthogonal

Bob mode controls persona and its native maximum tool set. T3 runtime mode and
the instance access ceiling further restrict that set. They never grant a tool
omitted by the selected Bob mode.

Use this minimum mapping:

| T3 runtime mode     | Additional Bob restrictions                                                         |
| ------------------- | ----------------------------------------------------------------------------------- |
| `approval-required` | disable `edit`, `execute`, `mcp`, `subagent`, `browser`, and mode switching         |
| `auto-accept-edits` | disable `execute`, `mcp`, `subagent`, `browser`, and mode switching                 |
| `auto`              | same as `auto-accept-edits`; Bob has no public “routine action” approval classifier |
| `full-access`       | no T3 group restrictions                                                            |

Use the dedicated `--disable-mcp` and `--disable-subagents` flags as well as
group restrictions when those capabilities are unavailable. Apply the
instance `toolAccessCeiling` as another intersection. Keep file-regex
restrictions from custom Bob modes intact.

The UI must not call `approval-required` “ask before actions” for Bob, because
Bob cannot pause. Provider-specific text should say that unavailable actions
are blocked. Tests must prove restrictions by observing actual failed tool
attempts and filesystem state, not only argument construction.

### 9. Stage image attachments inside the Bob workspace

T3 persists normalized images below the server's `attachmentsDir`, outside the
project. Bob rejects a direct external path but reads an image staged within
the workspace. Implement attachment support in the adapter boundary:

1. Resolve only already-normalized T3 attachment IDs through the existing safe
   attachment-path helper; never accept a client path.
2. Create a collision-resistant, per-turn temporary directory under the
   workspace.
3. Copy each bounded image into it with a sanitized filename. A copy is safer
   and more portable than relying on symlink behavior.
4. Append explicit `@relative/path` references to the Bob prompt.
5. Remove staged files before emitting the terminal turn event so checkpointing
   and git status do not capture them.
6. Clean on cancellation and every failure path; clean stale T3-owned staging
   directories on session start without touching user files.

The Bob driver/adapter will need access to `ServerConfig.attachmentsDir` and the
filesystem/path services, following the existing Claude attachment patterns.
Test images with spaces and duplicate names, cleanup after success/error/
interrupt, Windows copy behavior, and a malicious attachment ID.

### 10. Keep Bob project behavior harness-owned

Bob loads its own `AGENTS.md`, custom modes, skills, lifecycle hooks, trust
rules, settings, and native MCP configuration. T3 passes prompt text unchanged
and does not scan or reinterpret `.bob`, `.agents`, or `.claude` metadata.

Bob 2.0 exposes no structured headless metadata listing. Consequently T3 does
not advertise Bob project commands, skills, or modes in composer autocomplete.
The provider instance's arbitrary `defaultMode` slug is passed through the
documented `--mode` option. Literal `$skill-name` text remains native Bob input.
Literal slash commands remain literal; their lack of expansion in `bob run` is
a harness limitation, not a feature T3 should emulate.

### 11. Represent modes and subagents honestly

Arbitrary Bob mode slugs are configured on the Bob provider instance and passed
to `--mode`. Mode selection is independent of runtime safety.

When Bob calls `spawn_subagent`:

- synthesize `task.started` from the parent tool use
- derive a short stable T3 task ID from the Bob tool ID
- include the Bob subagent name and description
- emit no progress rows while Bob is silent
- complete/fail the task when its parent tool result arrives
- strip only the structural `<task_result>` wrapper and render bounded content

Do not query Bob's private child-task/message tables to fabricate live progress;
that would couple core runtime behavior to private storage and would not be a
public headless stream.

### 12. Enforce rollback and T3 MCP limits before side effects

`CheckpointReactor` currently restores files before calling
`ProviderService.rollbackConversation`. For Bob that would mutate the workspace
and only then discover that conversation rollback is unsupported.

Before any restore, resolve the active provider instance and check internal
rollback capability. For Bob:

- hide/disable full conversation Revert in every client that exposes it
- reject the server command before filesystem mutation
- explain that Bob's public CLI cannot rewind/fork a task
- never resume an old Bob task after files have been restored

A separate explicit action may restore files and start a new Bob context, but
must state that provider conversation context is discarded. Mobile currently
does not expose the revert command; retain the server guard for future clients.

`ProviderService.startSession` currently issues a T3 MCP credential for every
provider, and `sendTurn` touches it. Check internal T3-MCP-injection capability
before issue/touch/revoke. Bob should neither receive nor create an unused T3
credential. Preserve Bob's native global `~/.bob/mcp_settings.json` and
workspace `.bob/mcp.json`; project config takes precedence, as documented in
[Bob MCP](https://bob.ibm.com/docs/shell/configuration/mcp/mcp-bobshell).

### 13. Cancellation owns the child process lifecycle

The existing Bob adapter interrupts an Effect fiber whose child lives in its
scope. That closes the process scope too early to drain Bob's final result.
Track the exact child and its stdout/stderr fibers in turn state.

On T3 interruption:

1. atomically mark the turn interrupted
2. send SIGINT to the exact Bob child
3. continue parsing bounded stdout/stderr for a short grace period
4. retain a valid final task ID and monotonic usage snapshot
5. ignore Bob's misleading success state
6. force-kill the same child after the deadline
7. emit terminal usage and `turn.completed(interrupted)` exactly once

Cover interruption during inference, file edit, command execution, MCP, and
subagent execution, plus a child that ignores SIGINT.

## Implementation sequence

1. **Protocol fixtures and shared decoder**
   - Check in sanitized fixtures from the verified Bob 2 streams, including
     success, tool events, orphan result, duplicate error, limit-success,
     missing-task stderr, subagent, and cancellation.
   - Implement the bounded Bob 2 decoder and usage parsers in isolation.
2. **Settings, version gate, and provider presentation**
   - Add the versioned Bob 2 config without Bob 1 migration behavior.
   - Require Bob 2, add the provider-managed routing model, hide model settings,
     and expose client/internal capabilities.
3. **Chat adapter and terminal cursor persistence**
   - Replace invocation, streaming, error precedence, task cursor, and
     `ProviderService` terminal snapshots.
   - Implement explicit missing-task recovery.
4. **Safety and lifecycle**
   - Map all four T3 runtime modes plus the access ceiling.
   - Implement exact-child cancellation, T3 MCP gating, and rollback preflight.
5. **Usage projection**
   - Add Bobcoin events/read model, token cache-write fields, private DB fallback,
     monotonic deltas, and web/mobile presentation.
6. **Attachments**
   - Add workspace staging and cleanup before terminal/checkpoint events.
7. **Harness-owned project behavior and subagents**
   - Pass the configured arbitrary mode slug to Bob without scanning project metadata.
   - Preserve prompts literally and map bounded subagent start/result events.
8. **Bob text generation**
   - Move title/branch/commit/PR generation to Bob 2 JSON mode with all side
     effects disabled.
9. **Documentation and integrated verification**
   - Update user setup/limitations, internals, glossary if needed, and
     operations troubleshooting.

## Focused automated verification

- explicit multi-instance Bob 2 config decoding
- Bob 1.x rejection and Bob 2.x version parsing
- exact argument construction on macOS/Linux and Windows
- every known stream event plus unknown/malformed/bounded input
- delta and reasoning assembly and optional `last_message` reconciliation
- orphan tool result and huge-ID normalization
- duplicate errors and success-after-error precedence
- pre-stream stderr classification
- first task persistence and resume after server reconstruction
- invalid/expired task recovery without silent context loss
- graceful cancellation cursor retention and forced termination
- Bobcoin cumulative/turn deltas and non-monotonic stream fallback
- public token fields and every SQLite failure/degradation path
- all four runtime modes intersected with every access ceiling
- actual denied file/command/MCP/subagent effects
- image staging, prompt references, and cleanup on every terminal path
- literal prompt preservation, including slash text
- literal skill invocation handled by Bob
- subagent start/result without fabricated progress
- rollback rejection before filesystem restore
- no T3 MCP credential lifecycle for Bob
- Bob 2 text generation for every operation and malformed JSON output
- capability behavior in web and mobile

## Final integrated verification

Use an authenticated Bob 2 installation and prove:

- a new task plus multiple resumed turns
- restart the T3 server and resume again
- Bob Agent, Plan, Ask, and a configured custom mode slug
- Supervised, auto-accept edits, Auto, Full access, and an instance ceiling
- a permitted edit and command plus their restricted equivalents
- native workspace MCP and `--disable-mcp` behavior
- a workspace rule, native skill invocation, literal slash text, and hook
- a subagent start and final result
- image attachment understanding and staging cleanup
- cancellation during a long-running tool with cursor retained
- max-turn and max-cost errors overriding success results
- Bobcoin, cumulative/last-turn token values, and no USD mislabeling
- missing-task recovery
- rollback rejected without changing files
- title, branch, commit, and PR text generation
- local, remote/relay, and tunnel connections where applicable
- web, desktop, iOS, and Android presentation

Browser or simulator verification still requires explicit approval before it is
started.

## Definition of done

The integration is complete when every Bob 2 capability available through the
public headless interface works end to end on the applicable T3 surfaces,
Bob-supported image attachments work through safe staging, Bob-native project
configuration is represented for the correct workspace, usage is labeled and
projected truthfully, and every unavailable behavior is rejected before it can
cause a side effect or misleading UI state.
