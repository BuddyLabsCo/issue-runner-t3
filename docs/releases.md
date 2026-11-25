# Releasing Issue Runner for T3 Code

Eligible changes on `main` create or update one release PR on `auto-release`.
Review and squash-merge or rebase that PR to authorize publication. The first
version is `0.1.0`; subsequent proposals default to a patch increase. A higher
maintainer-selected version survives proposal refreshes. Workflow-only changes
under `.github/` and release merges do not start a new proposal.

## Repository setup

Install the release GitHub App on `BuddyLabsCo/issue-runner-t3` with contents
and pull request write permissions. Configure repository secrets `APP_ID` and
`APP_PRIVATE_KEY`. The proposal workflow requests a repository-scoped App token
so release PRs trigger normal CI. The default workflow token remains read-only.

Allow squash and rebase merges, disable merge commits, and enable automatic
branch deletion. Merge the release PR only after its checks pass.

Routine npm publication uses GitHub Actions OpenID Connect (OIDC) on a
GitHub-hosted Ubuntu runner. After the initial manual publish, configure the
package's [Trusted Publisher](https://docs.npmjs.com/trusted-publishers/):

| Field | Value |
| --- | --- |
| Package | `issue-runner-t3` |
| Organization/user | `BuddyLabsCo` |
| Repository | `issue-runner-t3` |
| Workflow filename | `publish-release.yml` |
| Environment | Empty |
| Allowed action | Direct `npm publish` |

Configure the publisher when the next release is ready. npm requires a successful
OIDC publication within two days of adding the publisher. Recovering a manually
published version does not count as an OIDC upload.

Routine releases need no stored npm token or separate publication approval.
The publication script isolates npm configuration and removes legacy token
environment variables and npm configuration overrides.

## Candidate verification and publication

Release PRs run formatting, lint, typecheck, build and tests on Ubuntu and Windows.
Main push CI skips its matrix only for the exact same-repository `auto-release`
merge into `main`. Other pushes retain the checks.

The `publish-release` workflow checks out the actual merged commit, installs
locked dependencies, builds once and packs one candidate. The release script
validates the event, repository, branches, commit ancestry, merge shape, version,
lockfile versions, manifest identity and T3 package inventory. It reads the
packed manifest and calculates SHA-512 from the archive itself.

Publication does not rerun full CI or run a separate installed-candidate gate.
The existing CLI and companion skill tests run before merge. Publication uploads
the validated archive with public access and the `latest` dist-tag, then creates
immutable `v<version>` and the matching GitHub Release. The proposal and publication
workflows use separate, non-cancelling concurrency groups.

## First public release

When npm returns HTTP 404 for the package, the publication script stops before
publishing. The workflow retains `verified-t3-release` for 90 days, including the
substantive `.tgz` and its `.tgz.json` handoff. The handoff records the workflow run,
release commit, version, archive path, SHA-512 integrity and Trusted Publisher
identity.

1. Download the artifact from the original failed publication workflow.
2. Extract it and check that the handoff names the expected commit and version.
   In the extracted directory, verify the archive against the handoff:

   ```bash
   node --input-type=module -e '
   import { readFileSync } from "node:fs";
   import { createHash } from "node:crypto";
   const file = "issue-runner-t3-0.1.0.tgz";
   const handoff = JSON.parse(readFileSync(file + ".json", "utf8"));
   const integrity = "sha512-" +
     createHash("sha512").update(readFileSync(file)).digest("base64");
   if (integrity !== handoff.integrity) throw new Error("Integrity mismatch");
   console.log(integrity);
   '
   ```

3. Sign in to npm with an authorized account and publish the verified archive with
   two-factor authentication:

   ```bash
   npm login
   npm publish ./issue-runner-t3-0.1.0.tgz --access public --tag latest
   ```

4. Rerun the original publication workflow. It compares the candidate with npm's
   published integrity and `latest`, then creates the tag and GitHub Release.

Do not rebuild the manual bootstrap archive or publish a placeholder. A registry
failure other than HTTP 404 is an error, not a bootstrap signal.

## Recovery

Rerun the original workflow after correcting the reported failure. It reports
completed stages, reuses matching registry contents and tags, finishes missing
tag and Release stages, and publishes a matching draft Release. Conflicting
registry contents, `latest`, tags or Release identities stop recovery without
overwriting them. Use a new version for corrections to already published bytes.

Tags are written after npm publication. Because proposals select versions from
tags, a main push during partial publication can propose the same version again.
Finish recovery before merging another release.

## Implementation and live evidence

The release system adapts the [Herdr baseline at 9329117](https://github.com/BuddyLabsCo/issue-runner-herdr/tree/9329117c3596b234701a2f0bb4486869f86e8e47).
Tests use disposable Git repositories and substitute GitHub and npm services.
The existing package tests verify the installed T3 CLI and companion skill.

Local verification does not establish live App behavior, first-package creation,
Trusted Publisher configuration, successful OIDC publication or real-environment
acceptance. The maintainer owns those operations.
