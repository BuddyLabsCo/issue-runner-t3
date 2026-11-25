import assert from "node:assert/strict";
import { posixTest, releasePullRequest } from "./support/release-fixture.ts";
import {
  createPublishFixture,
  mergedRelease,
  publishEnvironment,
  readyPackage,
} from "./support/publish-support.ts";

await posixTest(
  "a matching event from another repository cannot publish T3",
  (t) => {
    const fixture = createPublishFixture(t);
    const { merge, tarball } = mergedRelease(fixture);
    const result = fixture.runExpectingFailure(
      "publish-release",
      publishEnvironment(merge, tarball, {
        GITHUB_REPOSITORY: "attacker/core",
        PR_HEAD_REPOSITORY: "attacker/core",
      }),
    );
    assert.match(
      result.stderr,
      /Release repository must be BuddyLabsCo\/issue-runner-t3/,
    );
    assert.deepEqual(fixture.calls("npm"), []);
    assert.equal(fixture.remoteTag("v0.1.1"), "");
  },
);

await posixTest("candidate repository metadata must identify T3", (t) => {
  const fixture = createPublishFixture(t, {
    ...readyPackage,
    manifest: {
      ...readyPackage.manifest,
      repository: {
        type: "git",
        url: "git+https://github.com/attacker/core.git",
      },
    },
  });
  const { merge, tarball } = mergedRelease(fixture);
  const result = fixture.runExpectingFailure(
    "publish-release",
    publishEnvironment(merge, tarball),
  );
  assert.match(
    result.stderr,
    /repository.url must identify BuddyLabsCo\/issue-runner-t3/,
  );
  assert.equal(
    fixture.calls("npm").some(({ args }) => args[0] === "publish"),
    false,
  );
});

await posixTest(
  "a rebased same-repository release publishes the actual main commit",
  (t) => {
    const fixture = createPublishFixture(t);
    fixture.propose("0.1.1");
    fixture.commit(
      "README.md",
      "# T3\n\nMain advanced.\n",
      "docs: update main",
    );
    fixture.git("checkout", "auto-release");
    fixture.git("rebase", "main");
    fixture.git("checkout", "main");
    fixture.git("merge", "--ff-only", "auto-release");
    fixture.git("push", "origin", "main");
    fixture.configureGitHub({
      pullRequests: [
        releasePullRequest(18, { state: "closed", body: "T3 release" }),
      ],
    });
    const merge = fixture.head();
    const tarball = fixture.pack(fixture.artifacts);
    const result = fixture.run(
      "publish-release",
      publishEnvironment(merge, tarball),
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fixture.remoteTag("v0.1.1"), merge);
  },
);

await posixTest(
  "an unrelated GitHub Release does not block publication",
  (t) => {
    const fixture = createPublishFixture(t);
    const { merge, tarball } = mergedRelease(fixture);
    const unrelated = {
      tag: "v9.0.0",
      draft: true,
      targetCommitish: fixture.git("rev-parse", "HEAD~1"),
    };
    fixture.configureGitHub({ releases: { "v9.0.0": unrelated } });
    const result = fixture.run(
      "publish-release",
      publishEnvironment(merge, tarball),
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(fixture.release("v9.0.0"), unrelated);
    assert.equal(fixture.remoteTag("v0.1.1"), merge);
    assert.deepEqual(fixture.release("v0.1.1"), {
      tag: "v0.1.1",
      draft: false,
    });
  },
);

await posixTest(
  "a same-tag draft without a tag targeting another commit is rejected before publishing",
  (t) => {
    const fixture = createPublishFixture(t);
    const { merge, tarball } = mergedRelease(fixture);
    const draft = {
      tag: "v0.1.1",
      draft: true,
      targetCommitish: fixture.git("rev-parse", "HEAD~1"),
    };
    fixture.configureGitHub({ releases: { "v0.1.1": draft } });
    const result = fixture.runExpectingFailure(
      "publish-release",
      publishEnvironment(merge, tarball),
    );
    assert.match(
      result.stderr,
      /GitHub Release identity does not match v0.1.1/,
    );
    assert.equal(
      fixture.calls("npm").some(({ args }) => args[0] === "publish"),
      false,
    );
    assert.equal(fixture.remoteTag("v0.1.1"), "");
    assert.deepEqual(fixture.release("v0.1.1"), draft);
  },
);

await posixTest(
  "recovery rejects matching registry bytes with a different latest version",
  (t) => {
    const fixture = createPublishFixture(t);
    const { merge, tarball } = mergedRelease(fixture);
    assert.equal(
      fixture.run("publish-release", publishEnvironment(merge, tarball)).status,
      0,
    );
    fixture.configureNpm({ latest: "0.2.0" });
    const result = fixture.runExpectingFailure(
      "publish-release",
      publishEnvironment(merge, tarball),
    );
    assert.match(result.stderr, /npm latest points at 0.2.0, not 0.1.1/);
    assert.equal(
      fixture.calls("npm").filter(({ args }) => args[0] === "publish").length,
      1,
    );
  },
);

await posixTest("a candidate missing package keywords cannot publish", (t) => {
  const fixture = createPublishFixture(t, {
    ...readyPackage,
    manifest: { ...readyPackage.manifest, keywords: [] },
  });
  const { merge, tarball } = mergedRelease(fixture);
  const result = fixture.runExpectingFailure(
    "publish-release",
    publishEnvironment(merge, tarball),
  );
  assert.match(result.stderr, /keywords must include issue-runner/);
  assert.equal(
    fixture.calls("npm").some(({ args }) => args[0] === "publish"),
    false,
  );
});

await posixTest(
  "a different checked-out commit cannot publish the event's release",
  (t) => {
    const fixture = createPublishFixture(t);
    const { merge, tarball } = mergedRelease(fixture);
    fixture.git("checkout", "HEAD~1");
    const result = fixture.runExpectingFailure(
      "publish-release",
      publishEnvironment(merge, tarball),
    );
    assert.match(result.stderr, /Check out the merged release commit/);
    assert.deepEqual(fixture.calls("npm"), []);
    assert.equal(fixture.remoteTag("v0.1.1"), "");
  },
);

await posixTest(
  "a same-tag draft targeting a branch that has advanced is rejected without a tag",
  (t) => {
    const fixture = createPublishFixture(t);
    const { merge, tarball } = mergedRelease(fixture);
    fixture.commit("README.md", "# Main advanced\n", "docs: update main");
    fixture.git("push", "origin", "main");
    fixture.git("checkout", merge);
    const draft = { tag: "v0.1.1", draft: true, targetCommitish: "main" };
    fixture.configureGitHub({ releases: { "v0.1.1": draft } });
    const failed = fixture.runExpectingFailure(
      "publish-release",
      publishEnvironment(merge, tarball),
    );
    assert.match(
      failed.stderr,
      /GitHub Release identity does not match v0.1.1/,
    );
    assert.equal(
      fixture.calls("npm").some(({ args }) => args[0] === "publish"),
      false,
    );
    assert.equal(fixture.remoteTag("v0.1.1"), "");
    assert.deepEqual(fixture.release("v0.1.1"), draft);

    // A matching existing remote tag determines identity, regardless of the
    // draft's targetCommitish (which GitHub ignores once the tag exists).
    fixture.tag("v0.1.1");
    const recovered = fixture.run(
      "publish-release",
      publishEnvironment(merge, tarball),
    );
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.deepEqual(fixture.release("v0.1.1"), { ...draft, draft: false });
    assert.equal(fixture.remoteTag("v0.1.1"), merge);
  },
);

await posixTest(
  "an existing draft with no tag can recover when its branch resolves to the release commit",
  (t) => {
    const fixture = createPublishFixture(t);
    const { merge, tarball } = mergedRelease(fixture);
    const draft = { tag: "v0.1.1", draft: true, targetCommitish: "main" };
    fixture.configureGitHub({ releases: { "v0.1.1": draft } });
    const result = fixture.run(
      "publish-release",
      publishEnvironment(merge, tarball),
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fixture.remoteTag("v0.1.1"), merge);
    assert.deepEqual(fixture.release("v0.1.1"), { ...draft, draft: false });
  },
);
