import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { compileFunction } from "node:vm";

import { parse } from "yaml";

interface Step {
  id?: string;
  uses?: string;
  run?: string;
  if?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
}

interface Job {
  if?: string;
  needs?: string;
  "runs-on": string;
  permissions?: Record<string, string>;
  outputs?: Record<string, string>;
  strategy?: Record<string, unknown>;
  steps: Step[];
}

interface Workflow {
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  concurrency?: Record<string, unknown>;
  jobs: Record<string, Job>;
}

function loadWorkflow(name: string): Workflow {
  return parse(
    readFileSync(
      new URL(`../../.github/workflows/${name}.yml`, import.meta.url),
      "utf8",
    ),
  ) as Workflow;
}

const workflow = loadWorkflow("ci");
const releaseMerge = workflow.jobs["release-merge"];
assert.ok(releaseMerge);
const classifier = releaseMerge.steps.find((step) => step.id === "release");
assert.equal(classifier?.uses, "actions/github-script@v9");
const script = classifier?.with?.script;
assert.equal(
  typeof script,
  "string",
  "Main CI must classify the actual release merge",
);
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
  assert.deepEqual(workflow.on, {
    pull_request: null,
    push: { branches: ["main"] },
  });
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.deepEqual(Object.keys(workflow.jobs).sort(), [
    "checks",
    "release-merge",
  ]);
  assert.equal(releaseMerge.if, "github.event_name == 'push'");
  assert.equal(releaseMerge["runs-on"], "ubuntu-latest");
  assert.deepEqual(releaseMerge.permissions, { "pull-requests": "read" });
  assert.equal(releaseMerge.steps.length, 1);
  assert.equal(classifier?.if, undefined);
  assert.deepEqual(releaseMerge.outputs, {
    skip: "${{ steps.release.outputs.result }}",
  });
  const checks = workflow.jobs.checks;
  assert.ok(checks);
  assert.equal(checks.needs, "release-merge");
  assert.equal(
    checks.if,
    "${{ !cancelled() && (github.event_name == 'pull_request' || needs.release-merge.outputs.skip != 'true') }}",
  );
  assert.deepEqual(checks.strategy, {
    "fail-fast": false,
    matrix: { os: ["ubuntu-latest", "windows-latest"] },
  });
  assert.equal(checks["runs-on"], "${{ matrix.os }}");
  assert.equal(checks.permissions, undefined);
  assert.deepEqual(checks.steps, [
    { uses: "actions/checkout@v7" },
    {
      uses: "actions/setup-node@v7",
      with: { "node-version": "22.18.0", cache: "npm" },
    },
    { run: "npm install --global npm@11.6.2" },
    { run: "npm ci" },
    { run: "npm run check" },
    { run: "npm run build" },
    { run: "npm test" },
  ]);
});

await test("publication builds and packs once without repeating CI or candidate acceptance", () => {
  const workflow = loadWorkflow("publish-release");
  assert.deepEqual(workflow.on, {
    pull_request: { types: ["closed"], branches: ["main"] },
  });
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.deepEqual(workflow.concurrency, {
    group: "publish-release",
    "cancel-in-progress": false,
  });
  assert.deepEqual(Object.keys(workflow.jobs), ["publish"]);
  const publish = workflow.jobs.publish;
  assert.ok(publish);
  assert.equal(
    publish.if,
    "${{ github.event.pull_request.merged == true && github.event.pull_request.head.ref == 'auto-release' && github.repository == 'BuddyLabsCo/issue-runner-t3' && github.event.pull_request.head.repo.full_name == github.repository }}",
  );
  assert.equal(publish.needs, undefined);
  assert.equal(publish["runs-on"], "ubuntu-latest");
  assert.deepEqual(publish.permissions, {
    contents: "write",
    "pull-requests": "read",
    "id-token": "write",
  });
  const pack = [
    'mkdir -p "$RUNNER_TEMP/release"',
    'archive="$(npm pack --ignore-scripts --pack-destination "$RUNNER_TEMP/release" --silent)"',
    String.raw`printf 'tarball=%s\n' "$RUNNER_TEMP/release/$archive" >> "$GITHUB_OUTPUT"`,
    "",
  ].join("\n");
  assert.deepEqual(
    publish.steps.map((step) => step.run ?? step.uses),
    [
      "actions/checkout@v7",
      "actions/setup-node@v7",
      "npm install --global npm@11.19.0",
      "npm ci",
      "npm run build",
      pack,
      "node scripts/release/publish-release.ts",
      "actions/upload-artifact@v7",
    ],
  );
  assert.deepEqual(publish.steps[0]?.with, {
    ref: "${{ github.event.pull_request.merge_commit_sha }}",
    "fetch-depth": 0,
  });
  assert.deepEqual(publish.steps[1]?.with, {
    "node-version": "22.18.0",
    "package-manager-cache": false,
  });
  assert.equal(publish.steps[5]?.id, "pack");
  assert.equal(publish.steps[6]?.id, "release");
  assert.deepEqual(publish.steps[6]?.env, {
    GH_TOKEN: "${{ secrets.GITHUB_TOKEN }}",
    GITHUB_REPOSITORY: "${{ github.repository }}",
    PR_NUMBER: "${{ github.event.pull_request.number }}",
    PR_MERGED: "${{ github.event.pull_request.merged }}",
    PR_HEAD_REF: "${{ github.event.pull_request.head.ref }}",
    PR_BASE_REF: "${{ github.event.pull_request.base.ref }}",
    PR_HEAD_REPOSITORY: "${{ github.event.pull_request.head.repo.full_name }}",
    MERGE_SHA: "${{ github.event.pull_request.merge_commit_sha }}",
    TARBALL: "${{ steps.pack.outputs.tarball }}",
  });
  assert.equal(
    publish.steps[7]?.if,
    "${{ always() && steps.release.outputs.verified_tarball != '' }}",
  );
  assert.deepEqual(publish.steps[7]?.with, {
    name: "verified-t3-release",
    path: "${{ steps.release.outputs.verified_tarball }}\n${{ steps.release.outputs.verified_tarball }}.json\n",
    "if-no-files-found": "error",
    "retention-days": 90,
  });
  assert.ok(publish.steps.slice(0, 7).every((step) => step.if === undefined));
  const manifest = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { scripts: Record<string, string> };
  assert.equal(manifest.scripts["release:accept"], undefined);
});

await test("release proposals use a repository-scoped App token and separate concurrency", () => {
  const workflow = loadWorkflow("auto-release-pr");
  assert.deepEqual(workflow.on, { push: { branches: ["main"] } });
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.deepEqual(workflow.concurrency, {
    group: "auto-release-pr",
    "cancel-in-progress": false,
  });
  assert.deepEqual(Object.keys(workflow.jobs), ["prepare-release"]);
  const job = workflow.jobs["prepare-release"];
  assert.ok(job);
  assert.equal(job["runs-on"], "ubuntu-latest");
  assert.equal(job.permissions, undefined);
  assert.equal(job.if, undefined);
  assert.deepEqual(
    job.steps.map((step) => step.run ?? step.uses),
    [
      "actions/create-github-app-token@v2",
      "actions/checkout@v7",
      "actions/setup-node@v7",
      "node scripts/release/auto-release-pr.ts",
    ],
  );
  assert.equal(job.steps[0]?.id, "app-token");
  assert.deepEqual(job.steps[0]?.with, {
    "app-id": "${{ secrets.APP_ID }}",
    "private-key": "${{ secrets.APP_PRIVATE_KEY }}",
    owner: "BuddyLabsCo",
    repositories: "issue-runner-t3",
  });
  assert.deepEqual(job.steps[1]?.with, {
    token: "${{ steps.app-token.outputs.token }}",
    "fetch-depth": 0,
  });
  assert.deepEqual(job.steps[2]?.with, { "node-version": 24 });
  assert.deepEqual(job.steps[3]?.env, {
    GH_TOKEN: "${{ steps.app-token.outputs.token }}",
    PUSH_BEFORE: "${{ github.event.before }}",
  });
  assert.ok(job.steps.every((step) => step.if === undefined));
});

await test("the renamed T3 package preserves its CLI and Skill identity", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ) as Record<string, unknown>;
  assert.equal(manifest.name, "issue-runner-agent-t3");
  assert.equal(manifest.packageManager, "npm@11.6.2");
  assert.equal(manifest.license, "MIT");
  assert.equal(manifest.exports, "./dist/enhancement.js");
  assert.deepEqual(manifest.bin, { "issue-runner-t3": "dist/cli.js" });
  assert.deepEqual(manifest.files, [
    "dist",
    "prompts/runner-pause-guidance.md",
    "skills/issue-runner-t3",
  ]);
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
});
