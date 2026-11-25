#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
const statePath = process.env.RELEASE_GH_STATE;
const logPath = process.env.RELEASE_COMMAND_LOG;
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
const flag = (name) => args[args.indexOf(name) + 1];
const bodyFile = args.includes("--body-file") ? flag("--body-file") : null;
const body = bodyFile ? fs.readFileSync(bodyFile, "utf8") : null;
fs.appendFileSync(
  logPath,
  JSON.stringify({
    command: "gh",
    args,
    body,
    token: Boolean(process.env.GH_TOKEN),
  }) + "\n",
);
if (state.fail === args[0] + " " + args[1]) {
  console.error("simulated gh " + state.fail + " failure");
  process.exit(42);
}
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
const repository = "BuddyLabsCo/issue-runner-t3";
const pulls = state.pullRequests;
const openRelease = (pr) =>
  pr.state === "open" &&
  pr.base.ref === "main" &&
  pr.base.repo?.full_name === repository &&
  pr.head.ref === "auto-release" &&
  pr.head.repo?.full_name === repository;

if (args[0] === "api") {
  if (!args.includes("--paginate") || !args.includes("--slurp"))
    process.exit(91);
  const url = new URL(args[1], "https://api.github.com/");
  if (url.pathname === `/repos/${repository}/pulls`) {
    const result = pulls.filter(
      (pr) =>
        pr.state === url.searchParams.get("state") &&
        pr.base.ref === url.searchParams.get("base") &&
        `${pr.head.repo?.full_name.split("/")[0]}:${pr.head.ref}` ===
          url.searchParams.get("head"),
    );
    // One result per page exercises the caller's pagination handling.
    console.log(
      JSON.stringify(result.length ? result.map((pr) => [pr]) : [[]]),
    );
  } else if (
    url.pathname.startsWith(`/repos/${repository}/commits/`) &&
    url.pathname.endsWith("/pulls")
  ) {
    const sha = url.pathname.split("/").at(-2);
    const result = pulls.filter(
      (pr) =>
        pr.merge_commit_sha === sha || pr.associatedCommits?.includes(sha),
    );
    console.log(
      JSON.stringify(result.length ? result.map((pr) => [pr]) : [[]]),
    );
  } else process.exit(91);
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "view") {
  if (flag("--json") !== "body") process.exit(92);
  const pr = pulls.find((pr) => pr.number === Number(args[2]));
  if (!pr) process.exit(92);
  console.log(pr.body);
  process.exit(0);
}
if (args[0] === "pr" && (args[1] === "create" || args[1] === "edit")) {
  if (body === null || !flag("--title")) process.exit(93);
  let pr;
  if (args[1] === "create") {
    if (pulls.some(openRelease)) process.exit(94);
    pr = {
      number: Math.max(16, ...pulls.map((pr) => pr.number)) + 1,
      state: "open",
      merged_at: null,
      merge_commit_sha: null,
      base: { ref: flag("--base"), repo: { full_name: repository } },
      head: { ref: flag("--head"), repo: { full_name: repository } },
    };
    pulls.push(pr);
  } else {
    pr = pulls.find((pr) => pr.number === Number(args[2]));
    if (!pr || pr.state !== "open") process.exit(95);
  }
  pr.title = flag("--title");
  pr.body = body;
  save();
  console.log(`https://github.com/${repository}/pull/${pr.number}`);
  process.exit(0);
}
const release = state.releases[args[2]];
if (args[0] === "release" && args[1] === "view") {
  if (!release) {
    console.error("release not found");
    process.exit(1);
  }
  const fields = {
    tagName: release.tag,
    isDraft: release.draft,
    targetCommitish: release.targetCommitish ?? "main",
  };
  console.log(
    JSON.stringify(
      Object.fromEntries(
        flag("--json")
          .split(",")
          .map((key) => [key, fields[key]]),
      ),
    ),
  );
  process.exit(0);
}
if (args[0] === "release" && args[1] === "create") {
  if (release || !args.includes("--verify-tag") || !flag("--notes"))
    process.exit(96);
  state.releases[args[2]] = { tag: args[2], draft: args.includes("--draft") };
  save();
  process.exit(0);
}
if (args[0] === "release" && args[1] === "edit") {
  if (!release || !args.includes("--draft=false")) process.exit(97);
  release.draft = false;
  save();
  process.exit(0);
}
process.exit(90);
