# T3 Code protocol

Native interfaces used by Runner with [T3 Code](https://github.com/pingdotgg/t3code) v0.1.11.

## MCP

[Tool contracts](https://github.com/pingdotgg/t3code/blob/main/packages/contracts/src/orchestratorMcp.ts): Streamable HTTP JSON-RPC, default endpoint `http://127.0.0.1:3773/mcp`. OAuth authorization code with PKCE; scopes `orchestration:read` and `orchestration:operate`. Tool responses use `structuredContent` or JSON in a text result.

| Tool | Parameters used | Purpose |
| --- | --- | --- |
| `orchestrator_capabilities` | Current calling thread | Invoking thread and inherited provider/model/options |
| `t3_project_read` | `projectId` | Project workspace root |
| `t3_project_list` | `limit: 1` | Authorization check |
| `t3_thread_read` | `threadId` | Thread identity, Project, Worktree and Run status |
| `t3_thread_read` | `threadId`, `view: "messages"`, `runLimit: 50`, optional `beforePosition`, `itemId`, `textOffset` | Observe Runs and read assistant replies |
| `t3_thread_launch` | `projectId`, `title`, `modelSelection`, `workspaceStrategy`, `clientRequestId` | Create an idle task thread |
| `t3_thread_send` | `threadId`, `message`, `mode: "queue"`, `clientRequestId` | Queue Assignment, recovery or diagnostic prompts |
| `t3_queue` | `threadId`, `action: "list"`, `limit: 1` | Check for queued turns |
| `t3_thread_organize` | `threadId`, `action: "unarchive"` or `"archive"` | Reopen or archive threads |
| `t3_thread_update` | `threadId`, `action: "rename"`, `title` | Rename threads |

- Create with `modelSelection: {instanceId, model, options: [{id, value}]}` and `workspaceStrategy: {type: "existing_worktree", worktreePath: cwd}`.
- Resume/archive require `activeRunId: null`, an inactive status (`idle`, `completed`, `failed`, `cancelled`, `interrupted`, `rolled_back`) and an empty queue (`items: []`, `nextCursor: null`).

## Terminal RPC

[Native RPC contract](https://github.com/pingdotgg/t3code/blob/main/packages/contracts/src/rpc.ts): JSON over WebSocket. Requests use `{_tag: "Request", id, tag, payload, headers}`; success is a correlated `Exit` containing `Success`.

| Interface | Parameters used | Purpose |
| --- | --- | --- |
| `t3 thread show` | Current thread ID | Verify local thread |
| `t3 auth session issue` | `terminal:operate`, TTL 5m | Terminal session credential |
| `POST /api/auth/websocket-ticket/rpc` | Bearer credential | WebSocket ticket |
| `terminal.open` | `threadId`, new `terminalId`, `cwd`, `stopOnSettle: false` | Open Runner terminal |
| `terminal.write` | `threadId`, `terminalId`, Runner command plus Enter | Start Runner |

## Interaction sequences

### Authorize Runner

```mermaid
sequenceDiagram
    participant R as Runner
    participant U as Browser
    participant T as Native T3
    R->>T: POST /oauth/mcp/register
    T-->>R: Client ID
    R->>U: Authorization URL (PKCE)
    U->>T: Approve access
    T-->>U: Loopback redirect
    U->>R: Code, state, issuer
    R->>T: POST /oauth/mcp/token
    T-->>R: Access token, scope, expiry
    R->>T: t3_project_list (limit 1)
    T-->>R: Projects
```

### Launch Runner from the companion Skill

```mermaid
sequenceDiagram
    participant S as Companion Skill
    participant T as Native T3
    S->>T: orchestrator_capabilities
    T-->>S: Thread ID, provider/model/options
    S->>T: t3_thread_read, t3_project_read
    T-->>S: Project and workspace root
    S->>T: t3 thread show
    S->>T: t3 auth session issue
    T-->>S: Terminal credential
    S->>T: POST /api/auth/websocket-ticket/rpc
    T-->>S: WebSocket ticket
    S->>T: terminal.open
    T-->>S: Terminal snapshot
    S->>T: terminal.write (command plus Enter)
    T-->>S: Acknowledgement
    Note over S,T: Disconnect leaves Runner running
```

### Create a task thread and submit an Assignment

```mermaid
sequenceDiagram
    participant P as T3 plugin
    participant T as Native T3
    P->>T: t3_thread_read (launcher threadId)
    T-->>P: Project ID
    P->>T: t3_project_list (limit 1)
    T-->>P: Projects
    P->>T: t3_thread_launch (existing_worktree, no message)
    T-->>P: threadId, projectId, runId null
    P->>T: t3_thread_send (threadId, mode queue)
    T-->>P: threadId, messageId, runId
    Note over P,T: Delivery acknowledgement, not task completion
```

### Observe a task thread

```mermaid
sequenceDiagram
    participant E as Enhancement
    participant T as Native T3
    loop Poll every 5s
        E->>T: t3_thread_read (view messages, runLimit 50)
        T-->>E: Thread, recentRuns, items, earlierPosition
        opt Inactive completed/interrupted Run
            loop Until latest assistant reply found
                E->>T: t3_thread_read (beforePosition)
                T-->>E: Earlier items
            end
            loop While reply text is truncated
                E->>T: t3_thread_read (itemId, textOffset)
                T-->>E: Text chunk, nextTextOffset
            end
        end
    end
    Note over E,T: Retry failed observations after 10s
```

### Resume a native thread

```mermaid
sequenceDiagram
    participant P as T3 plugin
    participant T as Native T3
    P->>T: t3_thread_read (saved threadId)
    T-->>P: Project, Worktree, Run status
    Note over P: Require exact identity and inactive Run
    P->>T: t3_queue (list, limit 1)
    T-->>P: Empty queue
    P->>T: t3_thread_read (same threadId)
    T-->>P: Revalidated thread
    opt Archived
        P->>T: t3_thread_organize (unarchive)
        T-->>P: Acknowledgement
    end
    opt Title differs
        P->>T: t3_thread_update (rename)
        T-->>P: Acknowledgement
    end
```

### Archive a task thread

```mermaid
sequenceDiagram
    participant P as T3 plugin
    participant T as Native T3
    P->>T: t3_thread_read (owned threadId)
    alt Already archived or thread_not_found
        T-->>P: Archived state or not found
    else Present and unarchived
        T-->>P: Thread state
        Note over P: Require inactive Run
        P->>T: t3_queue (list, limit 1)
        T-->>P: Empty queue
        P->>T: t3_thread_read (same threadId)
        T-->>P: Revalidated thread
        opt Still present and unarchived
            P->>T: t3_thread_organize (archive)
            T-->>P: Acknowledgement
        end
    end
```

### Retry uncertain create/send requests

```mermaid
sequenceDiagram
    participant P as T3 plugin
    participant T as Native T3
    loop Up to three attempts, 10s deadline each
        P->>T: tools/call (same token and clientRequestId)
        alt Acknowledged
            T-->>P: Tool result
            Note over P: Stop retries
        else Definitive rejection
            T-->>P: Error
            Note over P: Stop retries
        else Uncertain outcome
            T--xP: Timeout, disconnect, malformed receipt or orchestration_error
            Note over P: Wait 5s before retry
        end
    end
```
