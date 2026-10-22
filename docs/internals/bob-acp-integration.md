# Bob ACP integration

[`BobDriver`](../../apps/server/src/provider/Drivers/BobDriver.ts) binds upstream's local-command
ACP driver to `bob acp` and adds app-owned text generation. The shared driver owns authentication,
discovery, modes, commands, skills, permissions, and session lifecycle. Keep this boundary when
updating upstream; the fork does not scan Bob mode or skill files or rewrite skill prompts.

The ACP driver factory accepts a driver identity so existing Bob provider instances retain their
identity during migration. Its text-generation capability is enabled only for a wrapper that
supplies the corresponding implementation. Bob's disposable text-generation sessions disable MCP
and subagents and reject tool permission requests. They refuse checkout investigation requests.

Legacy `bob-managed` and `premium` model names were app routing keys. The fork converts these names
to ACP's `default` model in the copied V1 tables before V2 imports them. It does not translate the
fork's saved `provider_mode` column into ACP options.

The fork's old numbered migrations can collide with upstream migrations. `ForkSchemaPatches.ts`
removes their migration ledger rows and preserves legacy columns outside the numbered manifest.
Keep these compatibility patches while upgrades from the archived pre-V2 fork remain supported.
