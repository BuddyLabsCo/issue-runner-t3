import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const releaseScripts = fileURLToPath(
  new URL("../../../scripts/release", import.meta.url),
);

// The release scripts replace `gh` and `npm` with POSIX shims on PATH, so these
// cases run where an extensionless executable is invoked directly.
export const posixTest = process.platform === "win32" ? test.skip : test;

export interface CommandCall {
  command: string;
  args: string[];
  body: string | null;
  authConfig?: string | null;
  token: boolean;
}

function readState(file: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  return parsed as Record<string, unknown>;
}

export interface ReleaseFixture {
  cwd: string;
  artifacts: string;
  git: (...args: string[]) => string;
  write: (path: string, content: string) => void;
  commit: (path: string, content: string, title: string) => string;
  head: () => string;
  propose: (version: string) => void;
  squashMerge: (message?: string) => string;
  mergeCommit: () => string;
  tag: (tag: string) => void;
  run: (
    script: "auto-release-pr" | "publish-release",
    env?: Record<string, string>,
  ) => { status: number | null; stdout: string; stderr: string };
  runExpectingFailure: (
    script: "auto-release-pr" | "publish-release",
    env?: Record<string, string>,
  ) => { status: number | null; stdout: string; stderr: string };
  calls: (command: "gh" | "npm") => CommandCall[];
  configureGitHub: (patch: Record<string, unknown>) => void;
  configureNpm: (patch: Record<string, unknown>) => void;
  state: () => Record<string, unknown>;
  release: (tag: string) => unknown;
  npmState: () => Record<string, unknown>;
  pack: (directory: string) => string;
  remoteTag: (tag: string) => string;
  remoteHeads: (branch: string) => string;
}

export function releasePullRequest(
  number: number,
  overrides: Record<string, unknown> = {},
) {
  return {
    number,
    title: "Release proposal",
    body: "Release body",
    state: "open",
    merged_at: null,
    merge_commit_sha: null,
    base: { ref: "main", repo: { full_name: "BuddyLabsCo/issue-runner-t3" } },
    head: {
      ref: "auto-release",
      repo: { full_name: "BuddyLabsCo/issue-runner-t3" },
    },
    ...overrides,
  };
}

export interface FixtureOptions {
  manifest?: Record<string, unknown>;
  files?: Record<string, string>;
}

function defaultManifest(options: FixtureOptions): Record<string, unknown> {
  return (
    options.manifest ?? {
      name: "issue-runner-t3",
      private: true,
      type: "module",
    }
  );
}

export function createReleaseFixture(
  t: { after: (fn: () => void) => void },
  options: FixtureOptions = {},
): ReleaseFixture {
  const root = mkdtempSync(path.join(tmpdir(), "release-script-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, "repo");
  const origin = path.join(root, "origin.git");
  const bin = path.join(root, "bin");
  const githubState = path.join(root, "gh-state.json");
  const npmState = path.join(root, "npm-state.json");
  const log = path.join(root, "commands.jsonl");
  mkdirSync(cwd);
  mkdirSync(bin);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
    GH_TOKEN: "test-token",
    RELEASE_GH_STATE: githubState,
    RELEASE_NPM_STATE: npmState,
    RELEASE_COMMAND_LOG: log,
  };
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_COMMON_DIR",
  ]) {
    delete env[key];
  }

  writeFileSync(
    githubState,
    JSON.stringify({
      pullRequests: [],
      releases: {},
      fail: "",
    }),
  );
  writeFileSync(
    npmState,
    JSON.stringify({
      registry: {},
      latest: "",
      staleLatest: false,
      fail: "",
      message: "",
    }),
  );
  writeFileSync(log, "");
  for (const command of ["gh", "npm"]) {
    const script = path.join(bin, `release-${command}.mjs`);
    copyFileSync(
      new URL(`../../fixtures/release-${command}.mjs`, import.meta.url),
      script,
    );
    // Use an extensionless launcher to keep ESM detection independent of cwd.
    const executable = path.join(bin, command);
    writeFileSync(
      executable,
      `#!/bin/sh\nexec node "$(dirname "$0")/release-${command}.mjs" "$@"\n`,
    );
    chmodSync(executable, 0o755);
  }

  const exec = (command: string, args: string[]) =>
    spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: 30_000 });
  const git = (...args: string[]): string => {
    const result = exec("git", args);
    assert.equal(
      result.status,
      0,
      `git ${args.join(" ")}: ${result.stderr || result.error}`,
    );
    return result.stdout.trim();
  };
  const write = (file: string, content: string): void => {
    mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    writeFileSync(path.join(cwd, file), content);
  };

  git("init", "--bare", "-b", "main", origin);
  git("init", "-b", "main");
  git("config", "user.name", "Release Test");
  git("config", "user.email", "release-test@example.invalid");
  git("config", "commit.gpgsign", "false");
  git("config", "core.hooksPath", "/dev/null");
  git("remote", "add", "origin", origin);

  const manifest = defaultManifest(options);
  const version = manifest.version;
  const lockfile: Record<string, unknown> = {
    name: manifest.name,
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": {
        name: manifest.name,
        ...(typeof version === "string" ? { version } : {}),
      },
    },
  };
  write("package.json", `${JSON.stringify(manifest, null, 2)}\n`);
  write("package-lock.json", `${JSON.stringify(lockfile, null, 2)}\n`);
  for (const [file, content] of Object.entries(options.files ?? {})) {
    write(file, content);
  }
  git("add", ".");
  git("commit", "-m", "Initial implementation");
  git("push", "-u", "origin", "main");

  const commit = (file: string, content: string, title: string): string => {
    const before = git("rev-parse", "HEAD");
    write(file, content);
    git("add", ".");
    git("commit", "-m", title);
    return before;
  };

  const pack = (directory: string): string => {
    mkdirSync(directory, { recursive: true });
    const result = spawnSync(
      "npm",
      ["pack", "--ignore-scripts", "--pack-destination", directory],
      {
        cwd,
        encoding: "utf8",
        timeout: 60_000,
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
      },
    );
    assert.equal(result.status, 0, `npm pack: ${result.stderr}`);
    return path.join(directory, result.stdout.trim().split("\n").at(-1) ?? "");
  };

  const bumpVersion = (version: string): void => {
    const manifest = JSON.parse(
      readFileSync(path.join(cwd, "package.json"), "utf8"),
    ) as Record<string, unknown>;
    manifest.version = version;
    write("package.json", `${JSON.stringify(manifest, null, 2)}\n`);
    const lockfile = JSON.parse(
      readFileSync(path.join(cwd, "package-lock.json"), "utf8"),
    ) as { packages: Record<string, Record<string, unknown>> };
    lockfile.packages[""] = { ...lockfile.packages[""], version };
    write(
      "package-lock.json",
      `${JSON.stringify({ ...lockfile, version }, null, 2)}\n`,
    );
    const changelogPath = path.join(cwd, "CHANGELOG.md");
    const changelog = existsSync(changelogPath)
      ? readFileSync(changelogPath, "utf8")
      : "# Changelog\n";
    write(
      "CHANGELOG.md",
      `${changelog.trimEnd()}\n\n## ${version}\n\n- chore: release ${version}\n`,
    );
  };

  const run = (
    script: "auto-release-pr" | "publish-release",
    overrides: Record<string, string> = {},
  ) => {
    const result: SpawnSyncReturns<string> = spawnSync(
      process.execPath,
      [path.join(releaseScripts, `${script}.ts`)],
      {
        cwd,
        encoding: "utf8",
        timeout: 60_000,
        env: { ...env, ...overrides },
      },
    );
    assert.equal(
      result.error,
      undefined,
      "The script must finish without a spawn error",
    );
    return result;
  };

  return {
    cwd,
    artifacts: path.join(root, "artifacts"),
    git,
    write,
    commit,
    head: () => git("rev-parse", "HEAD"),
    propose: (version) => {
      git("checkout", "-b", "auto-release");
      bumpVersion(version);
      git("add", ".");
      git("commit", "-m", `chore: propose release v${version}`);
      git("push", "origin", "auto-release");
      git("checkout", "main");
    },
    squashMerge: (message = "chore: propose release") => {
      git("merge", "--squash", "auto-release");
      git("commit", "-m", message);
      git("push", "origin", "main");
      return git("rev-parse", "HEAD");
    },
    mergeCommit: () => {
      git("merge", "--no-ff", "auto-release", "-m", "chore: propose release");
      git("push", "origin", "main");
      return git("rev-parse", "HEAD");
    },
    tag: (tag) => {
      git("tag", tag);
      git("push", "origin", tag);
    },
    run,
    runExpectingFailure: (script, overrides = {}) => {
      const result = run(script, overrides);
      assert.notEqual(result.status, 0, "The release script must fail closed");
      return result;
    },
    calls: (command) =>
      readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as CommandCall)
        .filter((call) => call.command === command),
    configureGitHub: (patch) => {
      const current = JSON.parse(readFileSync(githubState, "utf8")) as object;
      writeFileSync(githubState, JSON.stringify({ ...current, ...patch }));
    },
    configureNpm: (patch) => {
      const current = JSON.parse(readFileSync(npmState, "utf8")) as object;
      writeFileSync(npmState, JSON.stringify({ ...current, ...patch }));
    },
    state: () => readState(githubState),
    release: (tag) =>
      (readState(githubState).releases as Record<string, unknown>)[tag] ?? null,
    npmState: () => readState(npmState),
    pack,
    remoteTag: (tag) =>
      git("ls-remote", "origin", `refs/tags/${tag}`).split(/\s+/)[0] ?? "",
    remoteHeads: (branch) =>
      git("ls-remote", "origin", `refs/heads/${branch}`).split(/\s+/)[0] ?? "",
  };
}
