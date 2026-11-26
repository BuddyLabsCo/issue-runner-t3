import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

export function runnerBins(prefix, platform) {
  return platform === "win32"
    ? ["issue-runner-t3", "issue-runner-t3.cmd", "issue-runner-t3.ps1"].map(
        (name) => join(prefix, name),
      )
    : [join(prefix, "bin", "issue-runner-t3")];
}

export function linkRunner(prefix, root, name, platform) {
  const target = join(root, name, "dist", "cli.js");
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, "#!/usr/bin/env node\n", { mode: 0o755 });
  for (const bin of runnerBins(prefix, platform)) {
    mkdirSync(dirname(bin), { recursive: true });
    rmSync(bin, { force: true });
    if (platform === "win32") {
      writeFileSync(bin, relative(prefix, target));
    } else {
      symlinkSync(target, bin);
    }
  }
}
