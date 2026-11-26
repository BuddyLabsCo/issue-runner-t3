# T3 Code protocol

## Native interfaces used

The T3 plugin targets [T3 Code](https://github.com/pingdotgg/t3code) v0.1.11 and implements [Core's terminal contract](https://github.com/BuddyLabsCo/issue-runner-core/blob/main/docs/terminal-contract.md) v2 using native T3 chat threads. The companion Skill separately uses T3's terminal RPC to launch Runner itself. This document describes the implementation, not live acceptance results.

### Task adapter

| MCP tool | Parameters used | Purpose |
| --- | --- | --- |
| `t3_project_list` | `limit: 1` | Check authorization with an authenticated read |
| `t3_thread_read` | `threadId` | Resolve the launcher's Project and verify saved or owned thread identities and state |
| `t3_thread_launch` | `projectId`, `title`, `modelSelection`, `workspaceStrategy`, `clientRequestId` | Create an idle task thread in the existing Core Worktree |
| `t3_thread_send` | `threadId`, `message`, `mode: "queue"`, `clientRequestId` | Submit the complete Assignment prompt |
| `t3_thread_send` | `threadId`, `message`, `mode: "queue"`, `clientRequestId` | Queue diagnostic advice in the launcher Thread |
| `t3_queue` | `threadId`, `action: "list"`, `limit: 1` | Check for queued turns before resume or archival |
| `t3_thread_organize` | `threadId`, `action: "unarchive"` or `"archive"` | Reopen or archive a task thread without deleting its history |
| `t3_thread_update` | `threadId`, `action: "rename"`, `title` | Update the saved thread's title to the current Core stage label |

The plugin uses the [T3 MCP tool contracts](https://github.com/pingdotgg/t3code/blob/main/packages/contracts/src/orchestratorMcp.ts) over Streamable HTTP JSON-RPC. The endpoint defaults to `http://127.0.0.1:3773/mcp`; `terminalPlugins.mcpUrl` overrides it. Each attempt creates an MCP client, negotiates the connection, sends `tools/call`, and closes the transport. The adapter reads `structuredContent` or parses the first text result as JSON.

Runner signs in through T3's [external MCP authorization](https://github.com/pingdotgg/t3code/blob/main/docs/user/outside-agents.md) with OAuth authorization code and PKCE. It requests `orchestration:read` and `orchestration:operate`, stores the granted token, scope and expiry privately under `~/.issue-runner-t3`, and checks them before each logical MCP call. The file key is the SHA-256 of the normalized endpoint URL. Runner does not refresh expired credentials.

`createTab` returns an opaque handle and bound I/O without creating a native thread. The plugin interprets `t3 start --provider <instance-id> --model <model> [--option <id>=<value>]` and `t3 resume {sessionref}` itself. Start maps to `modelSelection: {instanceId, model, options: [{id, value}]}` and `workspaceStrategy: {type: "existing_worktree", worktreePath: cwd}`. The native thread ID becomes Core's `sessionref`; screen reads and key chords are unsupported. Core discovers the bundled Enhancement from the `issue-runner-agent-t3` package root when an Agent uses `agent: t3`. The Enhancement uses the bound Tab I/O to return the exact native thread ID without a readiness probe.

The Enhancement polls the owned Thread with `t3_thread_read` every 5s, or after 10s when observation fails. It tracks Run ownership across Assignment replacements and adopts the latest in-progress Run. For `completed` or `interrupted`, it uses `beforePosition` to find the last assistant message of the current Assignment's latest Run and `itemId` and `textOffset` to read its complete text.

If the reply starts with `[action required]` after leading whitespace and the expected handoff is absent, the Enhancement requests a pause from Core once per Run and Item. It continues observing the Thread and handoff while paused. Only Runner Enter releases an active pause; native questions and approvals stay in T3. Core invalidates confirmations on Assignment completion or replacement, and the Enhancement clears local pause state on replacement or Tab cleanup.

Resume and archival require `activeRunId: null` and status `idle`, `completed`, `failed`, `cancelled`, `interrupted` or `rolled_back`, unless archival is already complete. Identity and queue checks are preflight checks, not atomic with mutations.

### Skill launcher

| Native interface | Parameters used | Purpose |
| --- | --- | --- |
| `orchestrator_capabilities` | Current calling thread | Read the invoking thread ID and inherited provider/model/options |
| `t3_project_read` | `projectId` | Resolve the T3 Project's workspace root |
| `t3 thread show` | Current thread ID | Verify that the thread exists on the local Server |
| `t3 auth session issue` | `terminal:operate`, TTL 5m | Obtain a short-lived terminal credential after operator approval |
| `POST /api/auth/websocket-ticket/rpc` | Authorized terminal credential | Obtain the ticket for a separate authenticated RPC connection |
| `terminal.open` | `threadId`, new `terminalId`, `cwd`, `stopOnSettle: false` | Open the Runner terminal in the current conversation |
| `terminal.write` | `threadId`, `terminalId`, Runner command plus Enter | Start Runner in that terminal |

The [native RPC contract](https://github.com/pingdotgg/t3code/blob/main/packages/contracts/src/rpc.ts) uses JSON messages over WebSocket. Requests contain `{_tag: "Request", id, tag, payload, headers}`; success requires a correlated `Exit` with a `Success` result. The launcher resolves the local Server from its runtime record and keeps its separate terminal credential in memory. Each request waits up to 10s. It verifies the terminal identity, running status and working directory before sending the command once. Closing the socket leaves the terminal running; the client controls panel visibility.

## Interaction sequences

### Authorize Runner

```mermaid
%%{init: {"sequence": {"width": 250, "wrap": true}}}%%
sequenceDiagram
    participant P as T3 plugin
    participant U as Operator browser
    participant N as Native T3
    Note over P: auth login resolves the MCP endpoint and creates a loopback callback with PKCE
    P->>N: POST /oauth/mcp/register
    N-->>P: OAuth client ID
    P->>U: Open authorization URL
    U->>N: Approve application access
    N-->>U: Redirect to loopback callback
    U->>P: Authorization code, state, issuer
    Note over P: Validate state and issuer
    P->>N: POST /oauth/mcp/token
    N-->>P: Access token, granted scope, expiry
    Note over P: Require operation scope and store credential privately
    P->>N: auth status: t3_project_list with limit 1
    N-->>P: projects
    Note over P: Missing, expired, insufficient or rejected access fails with a diagnostic
```

### Launch Runner from the companion Skill

```mermaid
%%{init: {"sequence": {"width": 250, "wrap": true}}}%%
sequenceDiagram
    participant S as Companion Skill
    participant N as Native T3
    participant P as Runner CLI
    S->>N: orchestrator_capabilities
    N-->>S: Current thread ID and inherited selection
    S->>N: t3_thread_read, t3_project_read
    N-->>S: Project identity and workspace root
    Note over S: Prepare config and Run selector, show command and links, obtain operator approval
    S->>N: t3 thread show (current thread)
    N-->>S: Thread exists on local Server
    S->>N: Request short-lived terminal session and WebSocket ticket
    N-->>S: Authorized RPC connection
    S->>N: terminal.open (threadId, new terminalId, launchDirectory)
    N-->>S: Terminal snapshot
    Note over S: Validate identity, cwd and running status
    S->>N: terminal.write (Runner command plus Enter)
    N->>P: Start Runner with T3CODE_THREAD_ID
    N-->>S: Write acknowledgement
    Note over S: Close RPC socket and end the turn
    Note over N,P: Terminal and Runner continue independently of the Skill
```

### Initialize and create a task thread

```mermaid
%%{init: {"sequence": {"width": 250, "wrap": true}}}%%
sequenceDiagram
    participant C as Core
    participant P as T3 plugin
    participant N as Native T3
    Note over P: Require T3CODE_THREAD_ID and check MCP authorization before invoking Core
    C->>P: Create terminal plugin
    P->>N: t3_thread_read (launcher threadId)
    N-->>P: thread with projectId
    Note over P: Validate launcher identity, capture Project ID
    C->>P: createTab(cwd, label, env, submitKey, signal)
    Note over P: Require absolute cwd, empty env overlay and Enter
    P->>N: t3_project_list (limit 1)
    N-->>P: projects
    P-->>C: Owned handle and bound I/O
    Note over P: No native thread or command yet
    C->>P: execute(handle, t3 start ...)
    P->>N: t3_thread_launch (projectId, title, modelSelection, existing_worktree, clientRequestId)
    Note over N: Bind to Core's exact Worktree, omit initial message
    N-->>P: threadId, projectId, runId null
    Note over P: Require matching Project and a new ID distinct from the launcher, bind handle
    P-->>C: Native sessionref
    Note over C: Validate and checkpoint native reference, skip Session Probe
```

### Submit a task and verify completion

```mermaid
%%{init: {"sequence": {"width": 250, "wrap": true}}}%%
sequenceDiagram
    participant C as Core
    participant P as T3 plugin
    participant N as Native T3
    Note over C: Print stage, thread ID and expected handoff path
    C->>P: Bound io.submitText(complete Assignment)
    Note over P: Require owned bound thread and non-aborted signal
    P->>N: t3_thread_send (threadId, message, mode: queue, clientRequestId)
    N-->>P: threadId, messageId, runId
    Note over P: Require matching thread ID and nonempty message and run IDs
    P-->>C: Delivery acknowledged
    Note over C,N: An acknowledgement is not task completion
    N->>N: Agent works in the assigned Worktree
    Note over N,C: Agent writes handoff on the shared filesystem, not through MCP
    C->>C: Observe and verify handoff, persist accepted stage
    C->>P: closeTab(owned handle)
```

### Resume an exact native thread

```mermaid
%%{init: {"sequence": {"width": 250, "wrap": true}}}%%
sequenceDiagram
    participant C as Core
    participant P as T3 plugin
    participant N as Native T3
    C->>P: execute(handle, t3 resume saved sessionref)
    P->>N: t3_thread_read (saved threadId)
    N-->>P: Thread identity, Worktree, active run and status
    Note over P: Require exact Project and resolved Worktree, inactive run
    P->>N: t3_queue (list, limit 1)
    N-->>P: Empty queue, nextCursor null
    P->>N: t3_thread_read (same threadId)
    N-->>P: Revalidated thread, archived, title
    opt Archived
        P->>N: t3_thread_organize (unarchive)
        N-->>P: Sequence acknowledgement
    end
    opt Title differs from Core stage label
        P->>N: t3_thread_update (rename, label)
        N-->>P: Sequence and matching title
    end
    P-->>C: Exact saved sessionref
    Note over P,N: Failed preflight prevents mutation, failed unarchive or rename prevents dispatch
    Note over C: Continue the saved conversation, never replace it with a new thread
```

### Archive an owned task thread or confirm absence

```mermaid
%%{init: {"sequence": {"width": 250, "wrap": true}}}%%
sequenceDiagram
    participant P as T3 plugin
    participant N as Native T3
    Note over P: closeTab accepts only an owned handle
    alt Handle has no bound thread
        Note over P: Retire handle locally
    else Handle has a bound thread
        P->>N: t3_thread_read (owned threadId)
        alt Already archived or thread_not_found
            N-->>P: Archived state or not-found rejection
            Note over P: Retire handle without mutation
        else Present and not archived
            N-->>P: Thread state
            Note over P: Validate identity and Project, require inactive run
            P->>N: t3_queue (list, limit 1)
            N-->>P: Empty queue, nextCursor null
            P->>N: t3_thread_read (same threadId)
            N-->>P: Revalidated thread state
            alt Still present, inactive and unarchived
                P->>N: t3_thread_organize (archive)
                N-->>P: Sequence acknowledgement
                Note over P: Retire handle, preserve native history
            else Already archived or confirmed absent
                Note over P: Retire handle without mutation
            end
        end
    end
    Note over P,N: A not-found result during preflight confirms absence. Busy, unknown or failed closure retains ownership
```

### Settle requests and handle lost replies

```mermaid
%%{init: {"sequence": {"width": 250, "wrap": true}}}%%
sequenceDiagram
    participant P as T3 plugin
    participant N as Native T3
    Note over P: Load credential once per logical call, generate one clientRequestId for launch or send
    loop While unsettled, one attempt normally or up to three for launch/send
        P->>N: MCP connect and tools/call (same endpoint, token, arguments and request ID)
        alt Valid acknowledgement
            N-->>P: Correlated tool result
            Note over P: Resolve request
        else Definitive rejection
            N-->>P: Non-408 HTTP 4xx, definitive JSON-RPC or ordinary tool error
            Note over P: Reject without retry, preserve uncertainty from earlier attempts
        else Timeout, disconnect, malformed receipt or orchestration_error on launch/send
            N--xP: No confirmed successful result
            Note over P: Close transport, retry only launch/send after 5s if budget and signal permit
        end
    end
    Note over P: Each attempt has a 10s deadline, cancellation stops retries
    Note over P,N: Exhausted attempts can leave an idle thread or delivered prompt. Signing in again changes T3's deduplication scope. Core owns Operator Pause and recovery
```
