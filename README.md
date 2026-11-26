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

In the T3 Project conversation:

1. `$issue-runner-t3 setup` — check prerequisites.
2. `$issue-runner-t3 init` — configure the Project and User Prompts.
3. `$issue-runner-t3 run` — launch Runner.

- `$issue-runner-t3 upgrade` — update Runner and the Skill.
- `$issue-runner-t3 cleanup` — remove Project state, preserving `config.yaml` and `prompts/`.

## Configuration

T3 settings in `~/.issue-runner-t3/runner/<project>/config.yaml`:

```yaml
terminalPlugins:
  mcpUrl: http://127.0.0.1:3773/mcp
  pauseGuidance: true # Diagnostic advice on terminal confirmations
  enhancements:
    retryLimit: 3 # 0 disables missing-handoff recovery
    handoffRecoveryDelaySeconds: 120
    logLevel: error # error or info

agents:
  implement:
    agent: t3
    start: 't3 start --provider <instance-id> --model <model>' # Optional: --option <id>=<value>
    resume: 't3 resume {sessionref}'
    submitKey: Enter
  # Same settings for review, ciRepair, conflictRepair and documentation.
```

See the [code architecture](docs/code-architecture.md) for module ownership and the [T3 protocol](docs/t3-protocol.md) for native interfaces and interaction sequences.
