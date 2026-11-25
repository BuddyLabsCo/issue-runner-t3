# Issue Runner for T3 Code

Deliver GitHub Issues from native T3 Code task threads using [Issue Runner Core](https://github.com/BuddyLabsCo/issue-runner-core).

## Prerequisites

Meet the [Core prerequisites](https://github.com/BuddyLabsCo/issue-runner-core/blob/main/README.md#prerequisites), replacing the terminal multiplexer and Agent CLI requirements with these T3-specific checks:

- **T3 Code:** the `t3` CLI on `PATH` and at least one available, authenticated provider with advertised models (`orchestrator_capabilities`, `canRunChildTask: true`). Configure providers in T3 settings.
- **Runner:** check `issue-runner-t3 --version`; install with `npm install --global issue-runner-t3` if missing.

### Install the companion skill

Install the [companion skill](skills/issue-runner-t3/) in your T3 provider's skill directory.

### MCP URL

Use the current T3 Server's loopback address followed by `/mcp`. The runtime record is `userdata/server-runtime.json` under `T3CODE_HOME` (default `~/.t3`). The default URL is `http://127.0.0.1:3773/mcp`; see [T3's MCP URL instructions](https://github.com/pingdotgg/t3code/blob/main/docs/user/outside-agents.md#get-the-mcp-url) for other addresses.

### MCP authorization

Check authorization:

```bash
issue-runner-t3 auth status
```

If access is missing or invalid, sign in and approve the browser request:

```bash
issue-runner-t3 auth login
```

For a nondefault endpoint, append its URL to both commands and reuse it when initializing the Project.

## Setup and launch

In the conversation for the repository you want to work on:

1. `$issue-runner-t3 setup` — check the host and credentials, then approve any repairs, including installing Runner if needed.
2. `$issue-runner-t3 init` — configure the Project under `~/.issue-runner-t3/runner` and review its User Prompts.
3. `$issue-runner-t3 run` — choose Issues or Documentation Maintenance and launch Runner in the current conversation's terminal.

See the [code architecture](docs/code-architecture.md) for module ownership and the [T3 protocol](docs/t3-protocol.md) for native interfaces and interaction sequences.
