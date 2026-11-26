import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { linkRunner, runnerBins } from "./fixtures/upgrade-bin.mjs";

const packageName = "issue-runner-agent-t3";
const legacyName = "issue-runner-t3";
const latest = "2.3.4";
const source = fileURLToPath(
  new URL("../skills/issue-runner-t3/", import.meta.url),
);
const substitute = new URL("./fixtures/upgrade-npm.mjs", import.meta.url).href;

function fixture(
  t,
  { replacement = latest, legacy = false, platform = process.platform } = {},
) {
  const root = mkdtempSync(resolve(".test-upgrade-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const prefix = join(root, "global");
  const globalRoot =
    platform === "win32"
      ? join(prefix, "node_modules")
      : join(prefix, "lib", "node_modules");
  const bundle = join(root, "published-skill");
  const invoked = join(root, "provider-one", legacyName);
  const other = join(root, "provider-two", legacyName);
  const project = join(root, "project.yaml");
  const credentials = join(root, "credentials.json");
  const log = join(root, "npm.log");
  mkdirSync(globalRoot, { recursive: true });
  cpSync(source, bundle, { recursive: true });
  cpSync(bundle, invoked, { recursive: true });
  cpSync(bundle, other, { recursive: true });
  writeFileSync(project, "project config");
  writeFileSync(credentials, "credentials");
  writeFileSync(log, "");
  const install = (name, version) => {
    const path = join(globalRoot, name);
    mkdirSync(path, { recursive: true });
    writeFileSync(
      join(path, "package.json"),
      JSON.stringify({ name, version }),
    );
    cpSync(bundle, join(path, "skills", legacyName), { recursive: true });
    linkRunner(prefix, globalRoot, name, platform);
  };
  if (legacy) install(legacyName, "1.0.0");
  if (replacement) install(packageName, replacement);
  const run = (args, failure = "") =>
    spawnSync(
      process.execPath,
      [
        "--import",
        substitute,
        join(invoked, "scripts", "upgrade.mjs"),
        ...args,
      ],
      {
        encoding: "utf8",
        timeout: 5000,
        env: {
          ...process.env,
          UPGRADE_ROOT: globalRoot,
          UPGRADE_PREFIX: prefix,
          UPGRADE_PLATFORM: platform,
          UPGRADE_BUNDLE: bundle,
          UPGRADE_LOG: log,
          UPGRADE_LATEST: latest,
          UPGRADE_FAILURE: failure,
        },
      },
    );
  const check = () => {
    const result = run(["check"]);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const mutations = () =>
    readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(JSON.parse)
      .filter(([action]) => ["install", "uninstall"].includes(action));
  return {
    prefix,
    platform,
    globalRoot,
    bundle,
    invoked,
    other,
    project,
    credentials,
    run,
    check,
    mutations,
  };
}

test("a current package and complete current Skill need no update", (t) => {
  const f = fixture(t);
  const plan = f.check();
  assert.equal(plan.latest, latest);
  assert.deepEqual(plan.actions, []);
  assert.deepEqual(f.mutations(), []);
});

test("legacy-only migration requires both confirmations and installs the exact selected version", (t) => {
  const f = fixture(t, { replacement: null, legacy: true });
  makeStale(f);
  const before = contents(f.invoked);
  const plan = f.check();
  assert.deepEqual(plan.actions, [
    "Uninstall issue-runner-t3@1.0.0",
    "Install issue-runner-agent-t3@2.3.4",
    `Synchronize Skill at ${f.invoked}`,
  ]);
  for (const flags of [[], ["--approved"], ["--runner-stopped"]]) {
    assert.notEqual(f.run(["apply", plan.confirmationId, ...flags]).status, 0);
    assert.deepEqual(f.mutations(), []);
    assert.deepEqual(contents(f.invoked), before);
  }
  const result = f.run([
    "apply",
    plan.confirmationId,
    "--approved",
    "--runner-stopped",
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.mutations(), [
    ["uninstall", "--global", legacyName],
    ["install", "--global", `${packageName}@${latest}`, "--bin-links=true"],
  ]);
  assertRepaired(f);
});

function makeStale(f) {
  writeFileSync(join(f.invoked, "SKILL.md"), "old Skill instructions");
  writeFileSync(
    join(f.invoked, "scripts", "launch-terminal.mjs"),
    "old helper",
  );
  writeFileSync(join(f.invoked, "obsolete.txt"), "obsolete");
  mkdirSync(join(f.bundle, "scripts", "nested"));
  writeFileSync(
    join(f.bundle, "scripts", "nested", "new-helper.mjs"),
    "export {};",
  );
  const installedBundle = join(f.globalRoot, packageName, "skills", legacyName);
  if (existsSync(installedBundle))
    cpSync(f.bundle, installedBundle, { recursive: true });
  writeFileSync(join(f.other, "SKILL.md"), "other provider's Skill");
}

function contents(path) {
  return Object.fromEntries(
    readdirSync(path, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const file = join(entry.parentPath, entry.name);
        return [relative(path, file), readFileSync(file, "utf8")];
      }),
  );
}

function assertExecutable(f) {
  const target = join(f.globalRoot, packageName, "dist", "cli.js");
  for (const bin of runnerBins(f.prefix, f.platform)) {
    if (f.platform === "win32") {
      assert.equal(readFileSync(bin, "utf8"), relative(f.prefix, target));
    } else {
      assert.equal(realpathSync(bin), realpathSync(target));
    }
  }
}

function assertRepaired(f) {
  assertExecutable(f);
  assert.deepEqual(contents(f.invoked), contents(f.bundle));
  assert.equal(
    readFileSync(join(f.other, "SKILL.md"), "utf8"),
    "other provider's Skill",
  );
  assert.equal(readFileSync(f.project, "utf8"), "project config");
  assert.equal(readFileSync(f.credentials, "utf8"), "credentials");
  assert.deepEqual(f.check().actions, []);
}

const apply = (f, plan, failure) =>
  f.run(
    ["apply", plan.confirmationId, "--approved", "--runner-stopped"],
    failure,
  );

test("preflight failure or changed plan leaves packages and Skills untouched", (t) => {
  const f = fixture(t, { replacement: null, legacy: true });
  makeStale(f);
  const before = contents(f.invoked);
  const failure = f.run(["check"], "preflight");
  assert.notEqual(failure.status, 0);
  assert.match(failure.stderr, /registry unavailable/);
  assert.deepEqual(f.mutations(), []);
  assert.deepEqual(contents(f.invoked), before);
  const plan = f.check();
  writeFileSync(
    join(f.globalRoot, legacyName, "package.json"),
    JSON.stringify({ name: legacyName, version: "1.1.0" }),
  );
  assert.match(apply(f, plan).stderr, /plan changed/);
  assert.deepEqual(f.mutations(), []);
  assert.deepEqual(contents(f.invoked), before);
});

test("a missing bundle in the current package fails preflight before legacy removal", (t) => {
  const f = fixture(t, { legacy: true });
  rmSync(join(f.globalRoot, packageName, "skills"), { recursive: true });
  const before = contents(f.invoked);
  assert.notEqual(f.run(["check"]).status, 0);
  assert.deepEqual(f.mutations(), []);
  assert.deepEqual(contents(f.invoked), before);
});

test("a changed helper alone requires Skill repair", (t) => {
  const f = fixture(t);
  writeFileSync(
    join(f.invoked, "scripts", "launch-terminal.mjs"),
    "old helper",
  );
  const plan = f.check();
  assert.deepEqual(plan.actions, [`Synchronize Skill at ${f.invoked}`]);
  const result = apply(f, plan);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.mutations(), []);
  assert.deepEqual(contents(f.invoked), contents(f.bundle));
});

test("both packages present: remove the legacy package and restore the shared executable", (t) => {
  const f = fixture(t, { legacy: true });
  makeStale(f);
  const result = apply(f, f.check());
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.mutations(), [
    ["uninstall", "--global", legacyName],
    ["install", "--global", `${packageName}@${latest}`, "--bin-links=true"],
  ]);
  assertRepaired(f);
});

test("an outdated replacement is updated and its full Skill bundle is copied", (t) => {
  const f = fixture(t, { replacement: "2.0.0" });
  makeStale(f);
  const result = apply(f, f.check());
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.mutations(), [
    ["install", "--global", `${packageName}@${latest}`, "--bin-links=true"],
  ]);
  assertRepaired(f);
});

test("Skill-only repair includes nested helpers and removes obsolete files without reinstalling", (t) => {
  const f = fixture(t);
  makeStale(f);
  const result = apply(f, f.check());
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.mutations(), []);
  assertRepaired(f);
});

for (const failure of ["uninstall", "install"]) {
  test(`rerun converges after npm fails after ${failure}`, (t) => {
    const f = fixture(t, { replacement: "2.0.0", legacy: true });
    makeStale(f);
    const before = contents(f.invoked);
    const result = apply(f, f.check(), failure);
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      new RegExp(`Failed: .*failure after ${failure}`),
    );
    assert.doesNotMatch(result.stdout, /Upgrade complete/);
    if (failure === "install")
      assert.match(result.stdout, /Completed: Uninstall/);
    assert.deepEqual(contents(f.invoked), before);
    assert.equal(f.mutations().length, failure === "install" ? 2 : 1);
    const retry = apply(f, f.check());
    assert.equal(retry.status, 0, retry.stderr);
    assert.deepEqual(f.mutations(), [
      ["uninstall", "--global", legacyName],
      ["install", "--global", `${packageName}@${latest}`, "--bin-links=true"],
    ]);
    assertRepaired(f);
  });
}

for (const platform of new Set([process.platform, "win32"])) {
  test(`rerun restores the missing ${platform} executable after legacy removal with a current package`, (t) => {
    const f = fixture(t, { legacy: true, platform });
    const result = apply(f, f.check(), "uninstall");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Failed: Uninstall/);
    assert.ok(runnerBins(f.prefix, platform).every((bin) => !existsSync(bin)));
    const plan = f.check();
    assert.equal(plan.installed, latest);
    assert.equal(plan.legacyVersion, null);
    assert.ok(plan.actions.includes(`Install ${packageName}@${latest}`));
    const retry = apply(f, plan);
    assert.equal(retry.status, 0, retry.stderr);
    assert.deepEqual(f.mutations(), [
      ["uninstall", "--global", legacyName],
      ["install", "--global", `${packageName}@${latest}`, "--bin-links=true"],
    ]);
    assertExecutable(f);
    assert.deepEqual(f.check().actions, []);
  });
}
