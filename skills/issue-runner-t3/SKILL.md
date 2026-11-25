---
name: issue-runner-t3
description: Prepare and launch Issue Runner for the current T3 Code conversation. Use for $issue-runner-t3 setup (host checks and authorization), init (Project configuration and prompts), or run (Issue selection and reviewed terminal command).
---

# Issue Runner for T3 Code

Perform the requested action in the invoking conversation. Keep the operator in control of host repairs, Project settings, prompts, and the final launch. Runner, not this skill, owns Issue eligibility, Worktrees, Batches, PRs, integration and recovery.

## Resolve the current T3 project

- Run host checks and file operations on the machine and OS account of the conversation's integrated terminal. Verify the environment; if your tools cannot access it, guide the operator to run the checks there and use their results. Do not substitute an unrelated host or account.
- Call the conversation-scoped `orchestrator_capabilities`. Its `parentThreadId` identifies the invoking thread. Read that thread with `t3_thread_read`, then read its `thread.projectId` with `t3_project_read` to obtain `workspaceRoot`.
- Resolve the absolute workspace root on the T3 host. Use it as `checkout`, not the current thread's Worktree or the agent's incidental shell directory. Verify it is a Git checkout and derive GitHub `owner/repo` from `git remote get-url origin` there (HTTPS or SSH). Strip the transport syntax and optional `.git` suffix; redact any embedded credentials. Use the repository name as the Project key.
- For `init` and `run`, stop on missing or ambiguous identity or an invalid Core Project key. For `setup`, missing Git, MCP tools or project identity is a prerequisite gap: continue independent checks, defer dependent checks, and recheck after approved repairs.

## `$issue-runner-t3 setup`

Inspect before changing anything. Report each result, gaps, and required sign-ins. Use the [Core prerequisites](https://github.com/BuddyLabsCo/issue-runner-core/blob/416ca6d/README.md#prerequisites):

| Check | Evidence |
| --- | --- |
| Host and account | OS, account, shell and executable paths on the Runner host |
| Node.js and npm | `node --version` (>=22.18.0), `npm --version` (>=11) |
| Git and Worktrees | `git --version`, `git worktree list` in the checkout, effective `git config user.name` and `git config user.email` |
| Git transport | `git ls-remote origin` and `git push --dry-run origin HEAD` in the checkout; no actual push. Distinguish transport failure from branch-policy failure. |
| GitHub CLI | `gh --version`, `gh auth status`, `gh api user --jq .login`, `gh repo view <owner/repo> --json nameWithOwner,viewerPermission`. Check the normal user's access and grants: Issues, PRs, Actions and Contents read/write; Checks and Commit statuses read; repository metadata read. Treat permissions that cannot be verified without mutation as unverified, not as passed. Git transport and `gh` authenticate separately. |
| Runner | `issue-runner-t3 --version` |
| External MCP authorization | `issue-runner-t3 auth status [mcp-url]`, using the effective endpoint (default `http://127.0.0.1:3773/mcp`; read `terminalPlugins.mcpUrl` for an existing Project). Confirm any nondefault environment URL with the operator. |
| T3 provider | Current conversation's `orchestrator_capabilities`: at least one provider with `canRunChildTask: true`, advertised models and no authentication constraint. Check the inherited provider/model for init. |

Ask the operator to approve the proposed repairs before installing, changing configuration, or starting sign-ins. Use the host's installation mechanism for Node.js, npm, Git and `gh`; install Runner with `npm install --global issue-runner-t3`. Configure missing Git identity and transport access with the operator's details. Guide `gh auth login` or the required credential-helper/SSH setup. For missing or invalid MCP access, run `issue-runner-t3 auth login` (append the same custom URL if needed) and guide browser approval. For provider gaps, guide installation or sign-in through T3's provider settings. Never request or print tokens.

Recheck the affected prerequisites after repairs. Report outstanding blockers, including checks the operator must complete; don't claim readiness until confirmed. Offer `init` when setup is ready.

## `$issue-runner-t3 init`

1. Confirm the Launch Directory with the operator. Use an existing absolute directory (create it only with approval), resolving symlinks. Require it to be outside any Git repository or Worktree, including bare repositories; check `git -C <directory> rev-parse --git-dir` and distinguish not-a-repository from other errors. If it is inside a Git repository, ask for another location. Keep the directory and derived key in conversation context for `run`.
2. If `<Launch Directory>/<key>/config.yaml` exists, link it, report any missing User Prompts, and stop, without editing or reinitializing.
3. Before creating a Project, resolve the Agent start command from `inheritedProviderInstanceId`, `inheritedModel` and `inheritedOptions` in the conversation's `orchestrator_capabilities`. Match the provider by `providerInstanceId`, model by `id`, and the reasoning option's `id` and selected `value` against the model's advertised `options` and `values`. If there is no selected reasoning option, omit it rather than invent a value. If the selection is missing, unavailable or cannot be represented by the adapter (which splits the command on whitespace and accepts string option values), report the blocker and ask the operator to select a usable conversation model. Do not guess provider IDs or reasoning flags.
4. Run `issue-runner-t3 init --project <key>` from the Launch Directory (add `--mcp-url <url>` for a confirmed custom endpoint). Surface any Core error, including an existing child directory or retained partial output. Preserve it for inspection and stop; never adopt or delete partial output.
5. After successful initialization, edit only the following config values. Preserve all other template defaults and comments until the operator approves workflow choices:
   - `repository`: derived `owner/repo`; `checkout`: absolute T3 project workspace root; `issueLabel: ""`.
   - For each of `agents.implement`, `agents.review`, `agents.ciRepair`, `agents.conflictRepair`, and `agents.documentation`, set `agent: t3`, `resume: 't3 resume {sessionref}'` and `start: 't3 start --provider <instance-id> --model <model> [--option <id>=<value>]'` (substitute values; omit brackets and unused option).
6. Confirm these workflow settings, individually and in order, explaining the [Core workflow](https://github.com/BuddyLabsCo/issue-runner-core/blob/416ca6d/README.md#workflow-overview). Write the agreed values after each choice:
   - **Documentation Maintenance:** a Batch that delivers an Issue with the trigger label creates a Maintenance Ticket. Ask whether to enable it. If enabled, show and confirm `maintenanceTicket.title`, `.body`, `.label` and `workflow.docMaintainTriggerLabel`; all must be nonempty. If declined, retain the template defaults (empty trigger label).
   - **Review:** independent Review of implementation, with findings repaired in the original conversation. Set `workflow.review` to the choice. If enabled, confirm `workflow.maxReviewRounds` (positive integer, default 2).
   - **Administrator merge bypass:** set `codeHost.adminMerge` to the choice. Explain that GitHub still enforces the account's bypass permissions.
7. Link the completed `config.yaml` using an absolute local Markdown link. Apply requested corrections, revalidate the settings and wait for approval before moving on.
8. Present the generated User Prompts individually with their content and absolute local Markdown links. Confirm `prompts/implement.md` first, then `prompts/review.md` even if Review is disabled. If automatic Documentation Maintenance is enabled, also confirm `prompts/documentation.md`. Apply and confirm each prompt's edits before advancing.
9. Report the Launch Directory, Project key, and that `$issue-runner-t3 run` is available.

## `$issue-runner-t3 run`

Resolve the Launch Directory from conversation context; confirm with the operator if unknown. Verify it is outside Git and locate `<Launch Directory>/<key>/config.yaml`. Read the config, verify its `repository` and resolved `checkout` match the current T3 project, and stop on mismatch or missing config/prompts. Check Runner authorization against the configured endpoint.

Confirm the requested work and apply the selector table. Save the pre-selection `issueList` before editing so corrections can restore it. Validate Issue numbers as positive integers. For specific children, verify they belong to the Parent in the same repository. Use read-only tracker operations to preview the requested Issues or children. Only edit `issueList`; preserve all other configuration and prompts.

| Requested work | `issueList` edit | Selector |
| --- | --- | --- |
| One Issue (#42) | None | `--issue 42` |
| Multiple independent Issues | Replace with requested numbers | `--issue` |
| All eligible children of Parent #42 | Clear to `[]` | `--parent 42` |
| Specific children of Parent #42 | Replace with requested child numbers | `--parent 42` |
| Standalone Documentation Maintenance | None | `--document` |

Core determines eligibility (state, blockers, labels, reservations and assignees) and Batch ordering/size; do not override those decisions or promise that every previewed Issue will run. Auto-merge defaults on. Only a numbered `--issue` or `--document` supports an explicit `--auto-merge` or `--no-auto-merge`; the latter retains CI-ready unmerged work and reports incomplete. Reject incompatible flags rather than silently altering the request. See `issue-runner-t3 run --help`.

Preview the selected work, merge behavior, complete shell-quoted command including the change to the Launch Directory, and absolute local Markdown links to `config.yaml`, `prompts/implement.md`, `prompts/review.md`, and `prompts/documentation.md` (even when unused). Use `[config.yaml](/absolute/path/config.yaml)` or angle brackets around a path containing spaces. Confirm the integrated terminal's shell. Quote paths and arguments for that shell, and ensure a failed directory change prevents execution, for example on Bash:

```bash
cd '/home/operator/Runner Projects' && issue-runner-t3 run --project widget-api --issue 42
```

For PowerShell use `Set-Location -LiteralPath '<path>' -ErrorAction Stop; if ($?) { issue-runner-t3 run --project widget-api --issue 42 }` (escape embedded single quotes by doubling them).

Apply requested selection corrections and show an updated preview; preserve the original `issueList` if the corrected selector requires no change. Wait for final approval. Then give the complete command to paste into the current conversation's T3 integrated terminal. The operator opens the terminal and starts Runner manually; neither MCP nor the skill launches it. The terminal supplies `T3CODE_THREAD_ID`. Follow Core's printed stage, native T3 thread ID and handoff path for each assignment; task threads appear in this T3 project.
