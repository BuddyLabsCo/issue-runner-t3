import assert from "node:assert/strict";
import childProcess from "node:child_process";
import {
  appendFileSync,
  cpSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { linkRunner, runnerBins } from "./upgrade-bin.mjs";

const {
  UPGRADE_ROOT: root,
  UPGRADE_PREFIX: prefix,
  UPGRADE_PLATFORM: platform,
  UPGRADE_BUNDLE: bundle,
  UPGRADE_LOG: log,
  UPGRADE_LATEST: latest,
  UPGRADE_FAILURE: failure,
} = process.env;

Object.defineProperty(process, "platform", { value: platform });

childProcess.execFileSync = (file, args) => {
  assert.equal(file, "npm");
  appendFileSync(log, JSON.stringify(args) + "\n");
  if (failure === "preflight") throw new Error("registry unavailable");
  if (args[0] === "view") {
    assert.deepEqual(args, [
      "view",
      "issue-runner-agent-t3@latest",
      "version",
      "--json",
    ]);
    return JSON.stringify(latest);
  }
  if (args[0] === "root") {
    assert.deepEqual(args, ["root", "--global"]);
    return root + "\n";
  }
  if (args[0] === "prefix") {
    assert.deepEqual(args, ["prefix", "--global"]);
    return prefix + "\n";
  }
  if (args[0] === "uninstall") {
    assert.deepEqual(args, ["uninstall", "--global", "issue-runner-t3"]);
    rmSync(join(root, "issue-runner-t3"), { recursive: true });
    for (const bin of runnerBins(prefix, platform))
      rmSync(bin, { force: true });
  } else {
    assert.deepEqual(args, [
      "install",
      "--global",
      `issue-runner-agent-t3@${latest}`,
      "--bin-links=true",
    ]);
    const path = join(root, "issue-runner-agent-t3");
    rmSync(path, { recursive: true, force: true });
    mkdirSync(path, { recursive: true });
    writeFileSync(
      join(path, "package.json"),
      JSON.stringify({ name: "issue-runner-agent-t3", version: latest }),
    );
    cpSync(bundle, join(path, "skills", "issue-runner-t3"), {
      recursive: true,
    });
    linkRunner(prefix, root, "issue-runner-agent-t3", platform);
  }
  if (failure === args[0]) throw new Error(`failure after ${args[0]}`);
  return "";
};
syncBuiltinESMExports();
