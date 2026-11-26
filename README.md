# Issue Runner for T3 Code

Deliver GitHub Issues from native T3 Code task threads using [Issue Runner Core](https://github.com/BuddyLabsCo/issue-runner-core).

## Prerequisites

Meet the [Core prerequisites](https://github.com/BuddyLabsCo/issue-runner-core/blob/main/README.md#prerequisites), replacing the terminal multiplexer and Agent CLI requirements with these T3-specific checks:

- **T3 Code:** the `t3` CLI on `PATH` and at least one available, authenticated provider with advertised models (`orchestrator_capabilities`, `canRunChildTask: true`). Configure providers in T3 settings.
- **Runner:** install with `npm install --global issue-runner-agent-t3`; check `issue-runner-t3 --version`. If you installed the legacy npm package, run `npm uninstall --global issue-runner-t3` first. The executable name stays the same.

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

Use `$issue-runner-t3 cleanup` to delete Project files, including saved Run state, while preserving `config.yaml` and `prompts`.

### Missing handoff recovery

Runner requests recovery when an eligible task Thread finishes or is interrupted without producing its expected handoff. By default it waits 120 seconds and allows three attempts per Assignment. See [recovery settings](docs/t3-protocol.md#missing-handoff-recovery) to change the delay or disable recovery without disabling Enhancement Pause.

### Pause guidance

By default, Runner queues diagnostic advice in the launcher conversation when a terminal confirmation becomes active. The prompt includes the latest 15 lines of Runner output. Choose the confirmation option yourself in the terminal; advice never resolves a pause.

To disable output collection and diagnostic messages, set `terminalPlugins.pauseGuidance` to `false` in the Project's `config.yaml`.

See the [code architecture](docs/code-architecture.md) for module ownership and the [T3 protocol](docs/t3-protocol.md) for native interfaces and interaction sequences.
