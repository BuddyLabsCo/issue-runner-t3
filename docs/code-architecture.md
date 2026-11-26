# Code architecture

This map describes where code belongs. The [Core integration contract](https://github.com/BuddyLabsCo/issue-runner-core/blob/main/docs/terminal-contract.md) defines the plugin interface; the [T3 protocol](t3-protocol.md) describes native calls and interaction sequences.

## Directory map

```text
/
|-- src/
|   |-- cli.ts                 # Executable and Core integration
|   |-- terminal.ts            # Native T3 task adapter
|   |-- pause-guidance.ts      # Run-level confirmation observer
|   |-- authorization.ts       # MCP transport and authorization checks
|   |-- credentials.ts         # Endpoint and credential storage
|   `-- oauth.ts               # Browser sign-in flow
|-- prompts/                   # Packaged Runner guidance prompt
|-- skills/issue-runner-t3/      # Operator workflows: setup, init and run
|   `-- scripts/               # Helpers invoked by the Skill
|-- scripts/release/           # Release proposal, validation and publication
|-- test/                      # CLI, adapter, Skill and release tests
|   |-- fixtures/              # Native protocol and external command substitutes
|   `-- release/               # Release script and workflow tests
|-- docs/                      # Project documentation
|   `-- agents/                # Repository instructions for Agents
`-- dist/                      # Generated JavaScript
```

## Module ownership

| Owner | Responsibility |
| --- | --- |
| `src/cli.ts` | Parse Runner commands, resolve the effective MCP endpoint, and prepare T3-specific Project settings. Delegate initialization and workflow execution to Core's `runCli`. |
| `src/terminal.ts` | Implement Core's terminal contract using native T3 threads. Own task handles, Project and thread identity, start/resume mapping, prompt delivery and archival. |
| `src/pause-guidance.ts` | Observe active Core confirmations without owning input. Queue diagnostics in the launcher Thread and cancel outstanding delivery when the confirmation ends. |
| `src/authorization.ts` | Connect to the MCP endpoint, make authenticated tool calls, validate authorization and handle timeouts, rejections and retries. |
| `src/credentials.ts` | Normalize endpoint URLs, store credentials privately per endpoint, and enforce token expiry and granted scope. |
| `src/oauth.ts` | Implement OAuth client registration, PKCE, browser authorization, loopback callback and token exchange. Pass the resulting credential to the credential store. |
| `skills/issue-runner-t3/` | Guide the operator through prerequisites, Project configuration, prompt review and Run selection. Keep conversational workflows out of the Runner CLI. |
| `skills/issue-runner-t3/scripts/` | Implement Skill-only automation, including opening the current T3 conversation's terminal and launching Runner. Keep these helpers separate from the task adapter. |
| `scripts/release/` | Prepare release proposals, validate packed artifacts, publish releases and recover incomplete publication stages. GitHub Actions supplies event identity and credentials. |
| `test/` | Verify installed CLI behavior, the adapter contract and Skill helpers. Keep simulated external interfaces under `fixtures/`. |
| `test/release/` | Verify workflow configuration and release-script behavior using disposable Git repositories and GitHub/npm substitutes in `test/fixtures/`. |
| `docs/` | Explain the architecture and native protocol. Keep Agent instructions under `docs/agents/`. |
| Core | Own Issue selection and Batches, Worktrees, Assignment dispatch, checkpoints, handoff verification, GitHub operations, integration and recovery. |

Keep T3-specific behavior in the T3 adapter or Skill. Shared workflow policy belongs to Core. Build output under `dist/` is generated from `src/`, not edited directly.
