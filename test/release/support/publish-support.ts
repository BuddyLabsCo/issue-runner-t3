import {
  createReleaseFixture,
  releasePullRequest,
  type FixtureOptions,
  type ReleaseFixture,
} from "./release-fixture.ts";

export const releaseRepository = "BuddyLabsCo/issue-runner-t3";

export const readyPackage = {
  manifest: {
    name: "issue-runner-agent-t3",
    repository: {
      type: "git",
      url: "git+https://github.com/BuddyLabsCo/issue-runner-t3.git",
    },
    version: "0.1.0",
    description: "Issue Runner for T3 Code",
    type: "module",
    exports: "./dist/enhancement.js",
    bin: { "issue-runner-t3": "dist/cli.js" },
    dependencies: { "issue-runner-core": "0.1.1" },
    keywords: [
      "issue-runner",
      "t3",
      "t3-code",
      "mcp",
      "cli",
      "github-issues",
      "workflow-automation",
      "ai-agents",
      "coding-agent",
    ],
    files: ["dist", "skills/issue-runner-t3"],
    engines: { node: ">=22.18.0 <23" },
    license: "MIT",
  },
  files: {
    "dist/cli.js": 'console.log("issue-runner-t3 0.1.1 (core 0.1.1)");\n',
    "dist/enhancement.js":
      "export const contractVersion = 3; export async function createEnhancement() {}\n",
    "dist/authorization.js": "export {};\n",
    "dist/credentials.js": "export {};\n",
    "dist/oauth.js": "export {};\n",
    "dist/terminal.js": "export {};\n",
    "skills/issue-runner-t3/SKILL.md": "# T3 companion skill\n",
    "skills/issue-runner-t3/scripts/launch-terminal.mjs": "export {};\n",
    "README.md": "# issue-runner-t3\n",
    "CHANGELOG.md": "# Changelog\n",
  },
};

export const releaseBody =
  "## Proposed release 0.1.1\n\n### Changelog\n\n- fix: [issue-7] repair publication\n";

export function createPublishFixture(
  t: { after: (fn: () => void) => void },
  options: FixtureOptions = readyPackage,
): ReleaseFixture {
  return createReleaseFixture(t, options);
}

export function publishEnvironment(
  mergeSha: string,
  tarball: string,
  overrides: Record<string, string> = {},
): Record<string, string> {
  return {
    GITHUB_REPOSITORY: releaseRepository,
    PR_NUMBER: "18",
    PR_MERGED: "true",
    PR_HEAD_REF: "auto-release",
    PR_BASE_REF: "main",
    PR_HEAD_REPOSITORY: releaseRepository,
    MERGE_SHA: mergeSha,
    TARBALL: tarball,
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.example.invalid/token",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "test-oidc-request-token",
    ...overrides,
  };
}

// A merged release pull request for 0.1.1 and the tarball packed from the
// merged commit, exactly as the publication job provides them.
export function mergedRelease(fixture: ReleaseFixture): {
  merge: string;
  tarball: string;
} {
  fixture.propose("0.1.1");
  const merge = fixture.squashMerge();
  fixture.configureGitHub({
    pullRequests: [
      releasePullRequest(18, {
        state: "closed",
        merged_at: "2026-11-25T00:00:00Z",
        merge_commit_sha: merge,
        title: "chore: propose release v0.1.1",
        body: releaseBody,
      }),
    ],
  });
  return { merge, tarball: fixture.pack(fixture.artifacts) };
}
