---
name: issue-runner-t3
description: Manage Issue Runner for the current T3 Code conversation. Use for $issue-runner-t3 setup (host checks and authorization), init (Project configuration and prompts), run (Issue selection and terminal launch), upgrade (global npm package and this Skill), or cleanup (remove Project files except configuration and prompts).
---

# Issue Runner for T3 Code

Prepare the Runner host, initialize a Project, launch Runner, upgrade its installation, and clean up Project files from the current T3 conversation.

## Prepare project parameters

Skip this section for `upgrade`.

- `checkout`: absolute T3 project root, not the current Worktree. Resolve via `orchestrator_capabilities` (`parentThreadId`) → `t3_thread_read` (`thread.projectId`) → `t3_project_read` (`workspaceRoot`) and verify it is a Git checkout.
- `repository`: GitHub `owner/repo` from `git remote get-url origin` in `checkout`; strip `.git` and redact credentials.
- `projectKey`: repository name, e.g. `widget-api` for `acme/widget-api`.
- `threadId` (`run` only): `parentThreadId` from `orchestrator_capabilities`.
- `launchDirectory` (`init`, `run`, and `cleanup` only): absolute path to `~/.issue-runner-t3/runner`. Create it if missing for `init` or `run` only.
- `mcpUrl` (`setup` and `init` only): the current T3 Server's [MCP URL](https://github.com/BuddyLabsCo/issue-runner-t3/blob/main/README.md#mcp-url). Ask the operator if it cannot be determined.
- `agentStart` (`init` only): `t3 start --provider <instance-id> --model <model> [--option <id>=<value>]` from `orchestrator_capabilities` (`inheritedProviderInstanceId`, `inheritedModel`, `inheritedOptions`). Require `canRunChildTask: true` and advertised values. Omit `--option` if no reasoning option is selected; resolve ambiguous or invalid selections with the operator.

If a required parameter is missing, ambiguous, or invalid, resolve it before `init`, `run`, or `cleanup`. For `setup`, report gaps and continue independent checks.

## `$issue-runner-t3 setup`

1. Read the [Issue Runner T3 prerequisites](https://github.com/BuddyLabsCo/issue-runner-t3/blob/main/README.md#prerequisites). Check each prerequisite using `mcpUrl` where applicable, without changing anything; report gaps and unverified permissions.
2. Obtain approval for repairs and sign-ins. If the legacy npm package is installed, use `upgrade`. Otherwise, install Runner with `npm install --global issue-runner-agent-t3` if missing. Guide the operator through required approvals.
3. Recheck and report remaining blockers. Offer `init` when setup is ready.

## `$issue-runner-t3 upgrade`

1. Read the latest version with `npm view issue-runner-agent-t3@latest version`. Use `npm root --global` to locate both global packages (`issue-runner-agent-t3` and legacy `issue-runner-t3`) and read their installed versions. Check the shared CLI link or Windows shims under `npm prefix --global`. If the replacement is current, compare the invoked Skill directory recursively with its bundled `skills/issue-runner-t3/`, including helpers. Stop without changes if any check fails or everything is current.
2. Show the selected version and proposed actions. Obtain both upgrade approval and confirmation that all Runner processes have stopped. Do not inspect or terminate processes. Stop without changes if either confirmation is missing.
3. If present, uninstall the legacy package with `npm uninstall --global issue-runner-t3`. Then install the confirmed exact version with `npm install --global issue-runner-agent-t3@<version> --bin-links=true` if the replacement is missing, outdated, missing CLI links, or the legacy package was removed. Legacy removal can remove the shared CLI link even when the replacement is current.
4. Synchronize the complete installed bundle into the invoked Skill directory only, including adding, replacing and removing files to match the bundle. Do not reinstall a current package for Skill-only repair. Preserve other Skills, Project files and credentials.
5. Stop at the first failure and report completed and failed actions. Rerun from step 1; do not roll back. Report success directly without an additional CLI verification.

## `$issue-runner-t3 init`

1. If `<launchDirectory>/<projectKey>/config.yaml` exists, provide clickable absolute file links in the chat for `config.yaml` and each existing User Prompt (`prompts/implement.md`, `prompts/review.md`, `prompts/documentation.md`). Report any missing User Prompts and stop without modifying existing files.
2. Run `issue-runner-t3 init --project <projectKey>` from `launchDirectory`, passing `--mcp-url <mcpUrl>` for a nondefault endpoint. If initialization fails, report the error and stop. Leave all files as they are.
3. Fill in `config.yaml` using the prepared parameters. Leave all other defaults and comments unchanged.
   ```yaml
   repository: <repository>
   checkout: <checkout>
   issueLabel: ""
   tracker:
     reservationLabel: t3:reserved
   ```
   Apply the following to all five profiles under `agents` (`implement`, `review`, `ciRepair`, `conflictRepair`, `documentation`):
   ```yaml
   agent: t3
   start: <agentStart>
   resume: 't3 resume {sessionref}'
   ```
4. Confirm these workflow settings, individually and in order, explaining the [Core workflow](https://github.com/BuddyLabsCo/issue-runner-core/blob/main/README.md#workflow-overview). Write the agreed values after each choice:
   - **Documentation Maintenance:** a Batch that delivers an Issue with the trigger label creates a Maintenance Ticket. Ask whether to enable it. If enabled, show and confirm `maintenanceTicket.title`, `.body`, `.label` and `workflow.docMaintainTriggerLabel`; all must be nonempty. If declined, retain the template defaults (empty trigger label).
   - **Review:** independent Review of implementation, with findings repaired in the original conversation. Set `workflow.review` to the choice. If enabled, confirm `workflow.maxReviewRounds` (positive integer, default 2).
   - **Batch size:** confirm `maxBatchSize`, the maximum number of Issues per Batch (positive integer, default 2).
   - **Administrator merge bypass:** set `codeHost.adminMerge` to the choice. Explain that GitHub still enforces the account's bypass permissions.
5. Link the completed `config.yaml` using an absolute local Markdown link. Apply requested corrections, revalidate the settings and wait for approval before moving on.
6. Present the generated User Prompts individually with their content and absolute local Markdown links. Confirm `prompts/implement.md` first. Confirm `prompts/review.md` only if Review is enabled, and `prompts/documentation.md` only if automatic Documentation Maintenance is enabled. Apply and confirm each prompt's edits before advancing.
7. Report `launchDirectory`, `projectKey`, and that `$issue-runner-t3 run` is available.

## `$issue-runner-t3 run`

Verify `<launchDirectory>/<projectKey>/config.yaml` matches `repository` and `checkout`. Stop on mismatch or missing config/prompts.

Confirm the requested work. Use read-only tracker queries to verify Issues and Parent membership. Save the original `issueList` and update only that field:

| Requested work | `issueList` edit | Selector |
| --- | --- | --- |
| One Issue (#42) | None | `--issue 42` |
| Multiple independent Issues | Replace with requested numbers | `--issue` |
| All eligible children of Parent #42 | Clear to `[]` | `--parent 42` |
| Specific children of Parent #42 | Replace with requested child numbers | `--parent 42` |
| Standalone Documentation Maintenance | None | `--document` |

If the operator requests manual PR review, add `--no-auto-merge` (only for a single numbered `--issue` or `--document`).

Show the Runner command (`issue-runner-t3 run --project=<projectKey> <selector> [--no-auto-merge]`) and clickable absolute file links to `config.yaml` and the User Prompts used by this Run. After the operator approves, invoke the Skill's [terminal launcher](scripts/launch-terminal.mjs) with the shell-quoted parameters and selector:

```text
node <skill-directory>/scripts/launch-terminal.mjs <threadId> <launchDirectory> <projectKey> <selector> [--no-auto-merge]
```

The launcher opens a new terminal in the current thread at `launchDirectory` and submits the Runner command. If the launcher exits with code 0, ask the operator to open the terminal drawer to view Runner output. Otherwise, report the error. End the turn after the launcher returns.

## `$issue-runner-t3 cleanup`

Verify the Project directory `<launchDirectory>/<projectKey>` matches the current repository and checkout. Show the deletion list and ask the operator to confirm Runner is stopped and approve cleanup. Recursively delete all entries, including hidden files, except `config.yaml` and `prompts/`, without following symbolic links. Verify and report the result.
