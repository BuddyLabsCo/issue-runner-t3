# Issue Runner for T3 Code

Deliver GitHub Issues from native T3 Code task threads using [Issue Runner Core](https://github.com/BuddyLabsCo/issue-runner-core).

Install the [companion skill](skills/issue-runner-t3/SKILL.md) by copying the `skills/issue-runner-t3` directory into the skill directory of your T3 conversation's provider. The npm package also includes this directory, available under `$(npm root -g)/issue-runner-t3/skills` after a global install (use the equivalent path on Windows). Select the skill from T3's `$` menu.

In the conversation for the repository you want to work on:

1. `$issue-runner-t3 setup` — check the host and credentials, then approve any repairs, including installing Runner if needed.
2. `$issue-runner-t3 init` — choose a Launch Directory, configure the Project, and review its User Prompts.
3. `$issue-runner-t3 run` — choose Issues or Documentation Maintenance and review the launch command.

Paste the approved command into that conversation's integrated terminal. Runner prints each assignment's stage, T3 thread ID, and handoff path.
