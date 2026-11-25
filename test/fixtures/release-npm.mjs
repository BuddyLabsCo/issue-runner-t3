#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
const args = process.argv.slice(2);
const statePath = process.env.RELEASE_NPM_STATE;
const logPath = process.env.RELEASE_COMMAND_LOG;
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
const flag = (name) => args[args.indexOf(name) + 1];
const userConfig = args.includes("--userconfig") ? flag("--userconfig") : null;
const authConfig =
  userConfig && fs.existsSync(userConfig)
    ? fs.readFileSync(userConfig, "utf8")
    : null;
const scopedToken =
  process.env["npm_config_//registry.npmjs.org/:_authToken"] ||
  process.env["NPM_CONFIG_//registry.npmjs.org/:_authToken"];
fs.appendFileSync(
  logPath,
  JSON.stringify({
    command: "npm",
    args,
    body: null,
    authConfig,
    token: Boolean(
      process.env.NODE_AUTH_TOKEN || process.env.NPM_TOKEN || scopedToken,
    ),
  }) + "\n",
);
if (state.fail === args[0] + " " + args[1] || state.fail === args[0]) {
  console.error(state.message || "simulated npm " + state.fail + " failure");
  process.exit(42);
}
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
if (args[0] === "view") {
  const spec = args[1],
    field = args[2];
  const separator = spec.lastIndexOf("@");
  const name = separator > 0 ? spec.slice(0, separator) : spec;
  const version = separator > 0 ? spec.slice(separator + 1) : null;
  if (name !== "issue-runner-t3") {
    console.error(
      "npm error code E404\nnpm error 404 Not Found - GET " +
        "https://registry.npmjs.org/" +
        encodeURIComponent(name),
    );
    process.exit(1);
  }
  if (field === "name") {
    if (state.missingPackage) {
      console.error("npm error code E404\nnpm error 404 Not Found");
      process.exit(1);
    }
    console.log(JSON.stringify(name));
  } else if (field === "dist-tags.latest") {
    if (!state.latest) {
      console.error("npm error code E404\nnpm error 404 Not Found");
      process.exit(1);
    }
    console.log(JSON.stringify(state.latest));
  } else if (field === "version" || field === "dist.integrity") {
    const published = state.registry[version];
    if (!published) {
      console.error(
        "npm error code E404\nnpm error 404 Not Found - GET " +
          "https://registry.npmjs.org/issue-runner-t3/" +
          version,
      );
      process.exit(1);
    }
    console.log(JSON.stringify(field === "version" ? version : published));
  } else process.exit(91);
  process.exit(0);
}
if (args[0] === "publish") {
  // npm can fall back to existing registry credentials after OIDC fails.
  if (state.oidcFailure && !scopedToken) {
    console.error(
      "npm error code ENEEDAUTH\nnpm error OIDC authorization failed",
    );
    process.exit(1);
  }
  if (!args.includes("--tag") || args[args.indexOf("--tag") + 1] !== "latest")
    process.exit(92);
  const tarball = args[1],
    version = tarball
      .split("-")
      .at(-1)
      .replace(/\.tgz$/, "");
  if (state.registry[version]) {
    console.error(
      "npm error code E403\nnpm error 403 You cannot publish over the previously published versions",
    );
    process.exit(1);
  }
  state.registry[version] =
    "sha512-" +
    crypto
      .createHash("sha512")
      .update(fs.readFileSync(tarball))
      .digest("base64");
  // A real registry can keep answering with the previous latest tag for a
  // while after a successful upload; only the exit status is authoritative.
  if (!state.staleLatest) state.latest = version;
  save();
  console.log("+ issue-runner-t3@" + version);
  process.exit(0);
}
process.exit(90);
