import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const replacement = "issue-runner-agent-t3";
const legacy = "issue-runner-t3";
const skill = realpathSync(fileURLToPath(new URL("../", import.meta.url)));
const digest = (value) => createHash("sha256").update(value).digest("hex");
const validVersion = (value) =>
  typeof value === "string" &&
  /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(value);

function npm(...args) {
  return execFileSync("npm", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  }).trim();
}

function installedVersion(root, name) {
  const directory = join(root, name);
  try {
    lstatSync(directory);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  const manifest = JSON.parse(
    readFileSync(join(directory, "package.json"), "utf8"),
  );
  if (manifest.name !== name || !validVersion(manifest.version))
    throw new Error(`Invalid installed package manifest: ${name}`);
  return manifest.version;
}

function hasExecutable(prefix, root) {
  const target = join(root, replacement, "dist", "cli.js");
  try {
    if (!statSync(target).isFile()) return false;
    if (process.platform === "win32") {
      const shimTarget = relative(prefix, target).replaceAll("\\", "/");
      return ["", ".cmd", ".ps1"].every((extension) =>
        readFileSync(join(prefix, legacy + extension), "utf8")
          .replaceAll("\\", "/")
          .includes(shimTarget),
      );
    }
    const bin = join(prefix, "bin", legacy);
    return (
      realpathSync(bin) === realpathSync(target) &&
      (statSync(bin).mode & 0o111) !== 0
    );
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function snapshot(directory, prefix = "") {
  const entries = Object.create(null);
  for (const entry of readdirSync(join(directory, prefix), {
    withFileTypes: true,
  }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) {
      entries[path] = "directory";
      Object.assign(entries, snapshot(directory, path));
    } else if (entry.isFile()) {
      entries[path] = digest(readFileSync(join(directory, path)));
    } else {
      throw new Error(`Unsupported Skill entry: ${join(directory, path)}`);
    }
  }
  return entries;
}

function bundledSkill(root) {
  return join(root, replacement, "skills", legacy);
}

function bundleSnapshot(root) {
  const directory = bundledSkill(root);
  if (!lstatSync(directory).isDirectory())
    throw new Error("Installed companion Skill is not a directory.");
  const entries = snapshot(directory);
  if (!entries["SKILL.md"] || entries["SKILL.md"] === "directory")
    throw new Error("Installed package is missing its companion Skill.");
  return entries;
}

function inspect() {
  const latest = JSON.parse(
    npm("view", `${replacement}@latest`, "version", "--json"),
  );
  if (!validVersion(latest)) throw new Error("Invalid latest npm version.");
  const globalRoot = npm("root", "--global");
  if (!isAbsolute(globalRoot)) throw new Error("Invalid global npm root.");
  const globalPrefix = npm("prefix", "--global");
  if (!isAbsolute(globalPrefix)) throw new Error("Invalid global npm prefix.");
  const installed = installedVersion(globalRoot, replacement);
  const legacyVersion = installedVersion(globalRoot, legacy);
  const current = JSON.stringify(snapshot(skill));
  const staleSkill =
    installed !== latest ||
    current !== JSON.stringify(bundleSnapshot(globalRoot));
  // Both packages own the same bin name; uninstall can remove the replacement link.
  const install =
    installed !== latest ||
    Boolean(legacyVersion) ||
    !hasExecutable(globalPrefix, globalRoot);
  const sync = install || staleSkill;
  const actions = [];
  if (legacyVersion) actions.push(`Uninstall ${legacy}@${legacyVersion}`);
  if (install) actions.push(`Install ${replacement}@${latest}`);
  if (sync) actions.push(`Synchronize Skill at ${skill}`);
  const plan = {
    latest,
    globalRoot,
    globalPrefix,
    installed,
    legacyVersion,
    skill,
    install,
    actions,
  };
  return { ...plan, confirmationId: digest(JSON.stringify(plan)) };
}

function synchronize(root, version) {
  if (installedVersion(root, replacement) !== version)
    throw new Error(
      "The installed package does not match the confirmed version.",
    );
  const source = bundleSnapshot(root);
  const current = snapshot(skill);
  if (JSON.stringify(source) === JSON.stringify(current)) return;
  for (const [path, kind] of Object.entries(current).reverse()) {
    if (
      !(path in source) ||
      (kind === "directory") !== (source[path] === "directory")
    )
      rmSync(join(skill, path), { recursive: true });
  }
  cpSync(bundledSkill(root), skill, { recursive: true });
}

function main() {
  const [command, id, ...flags] = process.argv.slice(2);
  if (command === "check" && id === undefined) {
    console.log(JSON.stringify(inspect(), null, 2));
    return;
  }
  if (
    command !== "apply" ||
    flags.length !== 2 ||
    !flags.includes("--approved") ||
    !flags.includes("--runner-stopped")
  )
    throw new Error(
      "Apply requires upgrade approval and confirmation that all Runner processes have stopped.",
    );

  const plan = inspect();
  if (plan.confirmationId !== id)
    throw new Error(
      "The upgrade plan changed. Check again and obtain both confirmations.",
    );
  if (!plan.actions.length) {
    console.log("No update needed.");
    return;
  }
  const perform = (action, operation) => {
    try {
      operation();
      console.log(`Completed: ${action}`);
    } catch (error) {
      throw new Error(`Failed: ${action}: ${error.message}`, { cause: error });
    }
  };
  if (plan.legacyVersion)
    perform(plan.actions.shift(), () => npm("uninstall", "--global", legacy));
  if (plan.install)
    perform(plan.actions.shift(), () =>
      npm(
        "install",
        "--global",
        `${replacement}@${plan.latest}`,
        "--bin-links=true",
      ),
    );
  if (plan.actions.length)
    perform(plan.actions.shift(), () =>
      synchronize(plan.globalRoot, plan.latest),
    );
  console.log("Upgrade complete.");
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
