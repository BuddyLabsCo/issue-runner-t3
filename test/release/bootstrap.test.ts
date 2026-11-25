import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { posixTest, releasePullRequest } from "./support/release-fixture.ts";
import {
  createPublishFixture,
  publishEnvironment,
} from "./support/publish-support.ts";

await posixTest(
  "a missing npm package retains a verified bootstrap handoff without publishing",
  (t) => {
    const fixture = createPublishFixture(t);
    fixture.propose("0.1.0");
    const merge = fixture.squashMerge();
    const tarball = fixture.pack(fixture.artifacts);
    fixture.configureGitHub({
      pullRequests: [
        releasePullRequest(18, {
          state: "closed",
          body: "First stable T3 release",
        }),
      ],
    });
    fixture.configureNpm({ missingPackage: true });
    const result = fixture.runExpectingFailure(
      "publish-release",
      publishEnvironment(merge, tarball, {
        GITHUB_RUN_ID: "123",
        GITHUB_OUTPUT: join(fixture.cwd, "step-output"),
        GITHUB_STEP_SUMMARY: join(fixture.cwd, "step-summary"),
      }),
    );
    assert.match(result.stderr, /manual bootstrap/);
    const handoff = JSON.parse(
      readFileSync(`${tarball}.json`, "utf8"),
    ) as Record<string, unknown>;
    assert.equal(handoff.commit, merge);
    assert.equal(
      handoff.workflowRun,
      "https://github.com/BuddyLabsCo/issue-runner-t3/actions/runs/123",
    );
    assert.equal(handoff.artifactName, "verified-t3-release");
    assert.match(
      readFileSync(join(fixture.cwd, "step-output"), "utf8"),
      /verified_tarball=/,
    );
    assert.match(
      readFileSync(join(fixture.cwd, "step-summary"), "utf8"),
      /Retained artifact: verified-t3-release/,
    );
    assert.equal(handoff.version, "0.1.0");
    assert.equal(handoff.package, "issue-runner-t3");
    assert.equal(
      handoff.integrity,
      `sha512-${createHash("sha512").update(readFileSync(tarball)).digest("base64")}`,
    );
    assert.deepEqual(handoff.trustedPublisher, {
      owner: "BuddyLabsCo",
      repository: "issue-runner-t3",
      workflow: "publish-release.yml",
      environment: null,
    });
    assert.equal(
      fixture.calls("npm").some(({ args }) => args[0] === "publish"),
      false,
    );
    assert.equal(fixture.remoteTag("v0.1.0"), "");
    assert.equal(fixture.release("v0.1.0"), null);
    // Simulate the maintainer publishing the retained bytes, then rerun without OIDC.
    fixture.configureNpm({
      missingPackage: false,
      registry: { "0.1.0": handoff.integrity },
      latest: "0.1.0",
    });
    const repacked = fixture.pack(join(fixture.artifacts, "rerun"));
    assert.deepEqual(readFileSync(repacked), readFileSync(tarball));
    const retry = fixture.run(
      "publish-release",
      publishEnvironment(merge, repacked, {
        ACTIONS_ID_TOKEN_REQUEST_URL: "",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "",
      }),
    );
    assert.equal(retry.status, 0, retry.stderr);
    assert.equal(fixture.remoteTag("v0.1.0"), merge);
    assert.deepEqual(fixture.release("v0.1.0"), {
      tag: "v0.1.0",
      draft: false,
    });
    assert.equal(
      fixture.calls("npm").some(({ args }) => args[0] === "publish"),
      false,
    );
  },
);
