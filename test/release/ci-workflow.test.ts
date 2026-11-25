import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { compileFunction } from "node:vm";

const workflow = readFileSync(
  new URL("../../.github/workflows/ci.yml", import.meta.url),
  "utf8",
);
const script = / {10}script: \|\n((?: {12}.*\n|\n)+)/u.exec(workflow)?.[1];
assert.ok(script, "Main CI must classify the actual release merge");
const classify = compileFunction(`return (async () => { ${script} })()`, [
  "github",
  "context",
]) as (github: unknown, context: unknown) => Promise<boolean>;
const context = {
  repo: { owner: "BuddyLabsCo", repo: "issue-runner-t3" },
  sha: "merged-commit",
};
const release = {
  merged_at: "2026-11-06T00:00:00Z",
  merge_commit_sha: context.sha,
  base: { ref: "main", repo: { full_name: "BuddyLabsCo/issue-runner-t3" } },
  head: {
    ref: "auto-release",
    repo: { full_name: "BuddyLabsCo/issue-runner-t3" },
  },
};

for (const [name, pulls, skip] of [
  ["a release merge", [release], true],
  ["a direct push", [], false],
  [
    "another base repository",
    [
      {
        ...release,
        base: { ...release.base, repo: { full_name: "fork/t3" } },
      },
    ],
    false,
  ],
  ["an unmerged release PR", [{ ...release, merged_at: null }], false],
  ["a later push", [{ ...release, merge_commit_sha: "older-commit" }], false],
  ["another target branch", [{ ...release, base: { ref: "other" } }], false],
  [
    "an ordinary PR",
    [{ ...release, head: { ...release.head, ref: "feature" } }],
    false,
  ],
  [
    "a fork's auto-release branch",
    [
      {
        ...release,
        head: { ...release.head, repo: { full_name: "fork/core" } },
      },
    ],
    false,
  ],
  [
    "a deleted source repository",
    [{ ...release, head: { ...release.head, repo: null } }],
    false,
  ],
] as const) {
  await test(`main CI classification: ${name}`, async () => {
    const endpoint = {};
    const github = {
      rest: { repos: { listPullRequestsAssociatedWithCommit: endpoint } },
      paginate: (method: unknown, args: unknown) => {
        assert.equal(method, endpoint);
        assert.deepEqual(args, { ...context.repo, commit_sha: context.sha });
        return Promise.resolve(pulls);
      },
    };
    assert.equal(await classify(github, context), skip);
  });
}

await test("Release PRs retain Ubuntu and Windows CI before merge", () => {
  assert.match(workflow, /pull_request:/u);
  assert.match(workflow, /github.event_name == 'pull_request'/u);
  assert.match(workflow, /os: \[ubuntu-latest, windows-latest\]/u);
  assert.match(workflow, /node-version: 22\.18\.0/u);
  assert.match(workflow, /npm install --global npm@11\.6\.2/u);
  assert.match(workflow, /npm ci/u);
  assert.match(workflow, /npm run check/u);
  assert.match(workflow, /npm run build/u);
  assert.match(workflow, /npm test/u);
});

await test("publication builds and packs once without repeating CI or candidate acceptance", () => {
  const publish = readFileSync(
    new URL("../../.github/workflows/publish-release.yml", import.meta.url),
    "utf8",
  );
  assert.match(publish, /node scripts\/release\/publish-release\.ts/u);
  assert.doesNotMatch(
    publish,
    /npm test|npm run (?:check|typecheck)|workflow_run|needs:|gh run watch/u,
  );
  const manifest = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { scripts: Record<string, string> };
  assert.equal(manifest.scripts["release:accept"], undefined);
  assert.doesNotMatch(publish, /release:accept/u);
  assert.equal((publish.match(/npm run build/gu) ?? []).length, 1);
  assert.equal((publish.match(/npm pack --ignore-scripts/gu) ?? []).length, 1);
  assert.match(publish, /retention-days: 90/u);
  assert.match(publish, /id-token: write/u);
});

await test("release proposals use a repository-scoped App token and separate concurrency", () => {
  const proposal = readFileSync(
    new URL("../../.github/workflows/auto-release-pr.yml", import.meta.url),
    "utf8",
  );
  const publication = readFileSync(
    new URL("../../.github/workflows/publish-release.yml", import.meta.url),
    "utf8",
  );
  assert.match(proposal, /permissions:\n {2}contents: read/u);
  assert.match(proposal, /app-id: .*secrets\.APP_ID/u);
  assert.match(proposal, /private-key: .*secrets\.APP_PRIVATE_KEY/u);
  assert.match(proposal, /repositories: issue-runner-t3/u);
  assert.match(proposal, /GH_TOKEN: .*steps\.app-token\.outputs\.token/u);
  assert.match(
    proposal,
    /group: auto-release-pr\n {2}cancel-in-progress: false/u,
  );
  assert.match(
    publication,
    /group: publish-release\n {2}cancel-in-progress: false/u,
  );
});

await test("the T3 manifest preserves its CLI and skill package identity", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ) as Record<string, unknown>;
  assert.equal(manifest.name, "issue-runner-t3");
  assert.equal(manifest.packageManager, "npm@11.6.2");
  assert.equal(manifest.license, "MIT");
  assert.deepEqual(manifest.bin, { "issue-runner-t3": "dist/cli.js" });
  assert.deepEqual(manifest.files, ["dist", "skills/issue-runner-t3"]);
  assert.deepEqual(manifest.repository, {
    type: "git",
    url: "git+https://github.com/BuddyLabsCo/issue-runner-t3.git",
  });
  assert.equal(
    manifest.homepage,
    "https://github.com/BuddyLabsCo/issue-runner-t3#readme",
  );
  assert.deepEqual(manifest.bugs, {
    url: "https://github.com/BuddyLabsCo/issue-runner-t3/issues",
  });
  assert.deepEqual(manifest.keywords, [
    "issue-runner",
    "t3",
    "t3-code",
    "cli",
    "mcp",
    "github-issues",
    "workflow-automation",
    "ai-agents",
    "coding-agent",
  ]);
  assert.equal(manifest.exports, undefined);
});
