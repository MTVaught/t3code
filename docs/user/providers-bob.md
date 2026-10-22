# IBM Bob

Install Bob Shell on the machine running the T3 server. Run `bob` there to complete its license,
sign-in, and workspace trust steps before starting a conversation in T3 Code. The Bob provider
runs `bob acp`; its settings allow an explicit executable path and provider-specific environment
variables, including a secret `BOB_API_KEY` when your account uses one.

Bob chat uses T3 Code's standard ACP integration. Modes, model options, slash commands, and skills
come from Bob's ACP advertisements. T3 does not read Bob mode or skill files or convert `$skill`
mentions into separate prompts. Options can appear after the ACP session connects. See
[ACP providers](providers-acp.md) for authentication, permissions, follow-ups, and session behavior.

Bob remains the default provider for thread titles, branch names, commit messages, and pull request
descriptions. These requests use disposable ACP sessions with MCP and subagents disabled and tool
permission requests denied. Bob cannot generate review guides that require checkout investigation;
select another review-guide model for that action.

When importing pre-V2 fork threads, T3 keeps their conversation text and provider selection but does
not restore the old live Bob session or apply the fork's saved Bob mode. Select an ACP-reported mode
when continuing an imported thread. The old database remains unchanged.
