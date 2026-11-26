import assert from "node:assert/strict";
import fs, { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { NativeConversations } from "../node_modules/issue-runner-core/dist/agent/conversation.js";
import { TerminalOperator } from "../node_modules/issue-runner-core/dist/adapters/terminal.js";
import { TerminalConfirmations } from "../node_modules/issue-runner-core/dist/run/confirmations.js";
import * as enhancement from "../dist/enhancement.js";
import { createT3Terminal } from "../dist/terminal.js";
import { saveCredential } from "../dist/credentials.js";
import { substitute } from "./fixtures/mcp-substitute.mjs";

const realTimeout = setTimeout;
const delay = (ms) => new Promise((resolve) => realTimeout(resolve, ms));
async function until(predicate) {
  for (let i = 0; i < 2000; i++) {
    if (predicate()) return;
    await delay(10);
  }
  assert.fail("Observation did not settle");
}

function reply(runId, itemId, position, text, extra = {}) {
  return {
    sourceThreadId: "task",
    runId,
    itemId,
    position,
    type: "assistant_message",
    text,
    textTruncated: false,
    updatedAt: "2026-11-26T00:00:00Z",
    ...extra,
  };
}

async function taskThread(home) {
  let status = "idle";
  let runs = [];
  let items = [];
  let chunks = new Map();
  let pending;
  let nextContinuation;
  let observationFailure;
  const seen = [];
  const sends = [];
  const server = await substitute(async (name, args, authorization) => {
    assert.equal(authorization, `Bearer ${server.token}`);
    if (name === "t3_thread_read") {
      if (args.threadId === "task") seen.push(args);
      if (args.view === "messages") {
        if (!args.itemId && args.beforePosition === undefined) {
          pending = Promise.withResolvers();
          await pending.promise;
          if (observationFailure) {
            const { response } = observationFailure;
            observationFailure = undefined;
            return response;
          }
        } else if (nextContinuation) {
          const update = nextContinuation;
          nextContinuation = undefined;
          update();
        }
      }
      const thread = {
        threadId: args.threadId,
        projectId: "project",
        worktreePath: home,
        status,
        activeRunId: status === "running" ? runs[0]?.runId : null,
        latestRunId: runs[0]?.runId ?? null,
        archived: false,
        title: "task",
      };
      if (args.threadId === "launcher") return { thread };
      assert.equal(args.threadId, "task");
      let page;
      if (args.itemId) page = [chunks.get(args.itemId)];
      else {
        page = items
          .filter((item) => item.position < (args.beforePosition ?? Infinity))
          .slice(-1);
      }
      const earlierPosition =
        !args.itemId && items.some((item) => item.position < page[0]?.position)
          ? page[0].position
          : null;
      return {
        thread,
        recentRuns: runs,
        items: page,
        earlierPosition,
        nextPosition: page.at(-1)?.position ?? null,
        hasMore: false,
      };
    }
    if (name === "t3_thread_send") {
      sends.push(args);
      return {
        threadId: "task",
        runId: "receipt",
        messageId: "receipt-message",
      };
    }
    if (name === "t3_queue") return { items: [], nextCursor: null };
    if (name === "t3_thread_organize") return { sequence: 1 };
    assert.fail(`Unexpected tool ${name}`);
  });
  return {
    server,
    release: () => pending?.resolve(),
    seen,
    sends,
    async releaseObservation() {
      await until(() => pending !== undefined);
      const observation = pending;
      pending = undefined;
      observation.resolve();
    },
    onContinuation(update) {
      nextContinuation = update;
    },
    failNext(disconnect = false) {
      observationFailure = {
        response: disconnect
          ? undefined
          : { code: "orchestration_error", message: "Unavailable" },
      };
    },
    set(nextStatus, runIds, messages, nextChunks = new Map()) {
      status = nextStatus;
      runs = runIds.map((runId, i) => ({
        runId,
        ordinal: runIds.length - i,
        status: i === 0 ? status : "completed",
      }));
      items = messages;
      chunks = nextChunks;
    },
    async poll() {
      await until(() => pending !== undefined);
      const observation = pending;
      observation.resolve();
      // The next request cannot start until all pages and handoff checks settle.
      // Hold its response until the next poll so assertions see a stable result.
      await until(() => pending !== observation);
    },
  };
}

function recoveryProbe(recover) {
  const requests = [];
  let settledRequests = 0;
  let instance;
  return {
    requests,
    waitForRequests: (count) => until(() => settledRequests === count),
    stopEnhancement: () => instance.stop(),
    module: {
      contractVersion: enhancement.contractVersion,
      async createEnhancement(io, request, context, settings) {
        instance = await enhancement.createEnhancement(
          io,
          async (id) => {
            requests.push(id);
            try {
              await recover(request, id);
            } finally {
              settledRequests++;
            }
          },
          context,
          settings,
        );
        return instance;
      },
    },
  };
}

async function fixture(
  t,
  config = { retryLimit: 0 },
  recover = (request, id) => request(id),
) {
  const home = await mkdtemp(join(tmpdir(), "enhancement-pause-"));
  const oldHome = process.env.HOME;
  const oldProfile = process.env.USERPROFILE;
  process.env.HOME = process.env.USERPROFILE = home;
  t.after(async () => {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    if (oldProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = oldProfile;
    await rm(home, { recursive: true, force: true });
  });
  const { server, release, ...thread } = await taskThread(home);
  t.after(async () => {
    release();
    await server.close(true);
  });
  await saveCredential(server.endpoint, {
    accessToken: server.token,
    expiresAt: Date.now() + 120_000,
    scope: "orchestration:operate",
  });
  const input = new PassThrough();
  const output = new PassThrough();
  let rendered = "";
  output.on("data", (chunk) => {
    rendered += chunk;
  });
  const controller = new AbortController();
  const operator = new TerminalOperator(controller.signal, { input, output });
  const confirmations = new TerminalConfirmations(operator, controller.signal);
  const terminal = await createT3Terminal(server.endpoint, "launcher");
  const conversations = new NativeConversations(
    terminal,
    controller.signal,
    undefined,
    undefined,
    confirmations,
  );
  const { module, ...probe } = recoveryProbe(recover);
  const tab = await conversations.create(
    { cwd: home, env: {}, label: "task", submitKey: "Enter" },
    module,
    config,
  );
  t.after(async () => {
    await conversations.stop(tab);
    controller.abort();
    input.destroy();
    output.destroy();
  });
  await conversations.ready(
    tab,
    { resume: "t3 resume {sessionref}" },
    "task",
    () => assert.fail("Unexpected terminal wait"),
  );
  return {
    ...thread,
    ...probe,
    io: tab.io,
    input,
    controller,
    confirmations,
    rendered: () => rendered,
    async assign(name) {
      const expectedFile = join(home, `${name}.json`);
      await conversations.submit(tab, name, {
        expectedFile,
        recoveryText: "continue",
      });
      return expectedFile;
    },
    manual: () => conversations.submit(tab, "manual follow-up"),
    complete: () => conversations.complete(tab),
    async stop() {
      await conversations.stop(tab);
      release();
    },
  };
}

test("only the latest attributable reply pauses; Enter resumes and processed markers stay deduplicated", async (t) => {
  const f = await fixture(t);
  await f.assign("first");
  const marked = reply("run-1", "marked", 0, "  [action required] please help");
  f.set("completed", ["run-1"], [marked, reply("run-1", "last", 1, "Done")]);
  await f.poll();
  assert.equal(f.confirmations.status.active, undefined);
  const truncated = reply("run-2", "split", 2, "  [action", {
    textTruncated: true,
    nextTextOffset: 9,
  });
  f.set(
    "interrupted",
    ["run-2", "run-1"],
    [
      marked,
      truncated,
      reply("run-2", "user", 3, "follow-up", { type: "user_message" }),
    ],
    new Map([["split", reply("run-2", "split", 2, " required] please help")]]),
  );
  await f.poll();
  assert.ok(f.seen.some((args) => args.beforePosition === 3));
  assert.ok(
    f.seen.some((args) => args.itemId === "split" && args.textOffset === 9),
  );
  const confirmation = f.confirmations.status.active;
  assert.ok(confirmation);
  await f.manual();
  f.set(
    "completed",
    ["run-3", "run-2"],
    [reply("run-3", "new", 4, "[action required] still waiting")],
  );
  await f.poll();
  assert.deepEqual(f.confirmations.status.active, confirmation);
  assert.deepEqual(f.confirmations.status.pending, []);
  f.input.write("invalid\n");
  await until(() => f.rendered().includes("Unsupported input."));
  assert.deepEqual(f.confirmations.status.active, confirmation);
  f.input.write("\n");
  await until(() => !f.confirmations.status.active);
  await f.poll();
  assert.equal(f.confirmations.status.active, undefined);
  f.set(
    "completed",
    ["run-4", "run-3"],
    [reply("run-4", "new", 5, "[action required] again")],
  );
  await f.poll();
  assert.ok(f.confirmations.status.active);
  assert.notEqual(f.confirmations.status.active.id, confirmation.id);
});

test("replacement isolates old Runs, adopts active Runs, and completion invalidates a pause before Enter", async (t) => {
  const f = await fixture(t);
  await f.assign("first");
  const prior = reply("old", "marker", 0, "[action required] old Assignment");
  f.set("completed", ["old"], [prior]);
  await f.poll();
  assert.ok(f.confirmations.status.active);
  await f.assign("second");
  await until(() => !f.confirmations.status.active);
  await f.poll();
  assert.equal(f.confirmations.status.active, undefined);

  const activeReply = reply(
    "active",
    "marker",
    1,
    "[action required] adopted Run",
  );
  f.set("running", ["active", "old"], [prior, activeReply]);
  await f.poll();
  assert.equal(f.confirmations.status.active, undefined);
  const expectedFile = await f.assign("third");
  f.set("completed", ["active", "old"], [prior, activeReply]);
  await f.poll();
  assert.ok(f.confirmations.status.active);
  const confirmation = f.confirmations.status.active;
  await writeFile(expectedFile, "{}");
  f.set(
    "completed",
    ["late", "active"],
    [reply("late", "marker", 2, "[action required] late reply")],
  );
  await f.poll();
  assert.deepEqual(f.confirmations.status.active, confirmation);
  await f.complete();
  await until(() => !f.confirmations.status.active);
  await f.poll();
  assert.equal(f.confirmations.status.active, undefined);
  const existingHandoff = await f.assign("fourth");
  await f.poll();
  assert.equal(f.confirmations.status.active, undefined);
  await writeFile(existingHandoff, "{}");
  f.set(
    "completed",
    ["fresh", "late"],
    [reply("fresh", "marker", 3, "[action required] already handed off")],
  );
  await f.poll();
  assert.equal(f.confirmations.status.active, undefined);
  await f.stop();
  const reads = f.seen.length;
  await delay(5200);
  assert.equal(f.seen.length, reads);
});

test("a Run first observed on a continuation page belongs to the old Assignment", async (t) => {
  const f = await fixture(t);
  await f.assign("first");
  f.set(
    "completed",
    ["old"],
    [
      reply("old", "split", 0, "[action", {
        textTruncated: true,
        nextTextOffset: 7,
      }),
    ],
  );
  const late = reply("late", "marker", 1, "[action required] old Assignment");
  f.onContinuation(() =>
    f.set(
      "completed",
      ["late", "old"],
      [late],
      new Map([["split", reply("old", "split", 0, " required]")]]),
    ),
  );
  await f.poll();
  assert.ok(f.seen.some((args) => args.itemId === "split"));
  assert.equal(f.confirmations.status.active, undefined);
  await f.assign("replacement");
  await f.poll();
  assert.equal(f.confirmations.status.active, undefined);
  f.set(
    "completed",
    ["fresh", "late"],
    [reply("fresh", "marker", 2, "[action required] new Assignment")],
  );
  await f.poll();
  assert.ok(f.confirmations.status.active);
});

test("observation loss prevents adopting a stale active Run on replacement", async (t) => {
  const f = await fixture(t);
  await f.assign("first");
  f.set("running", ["old"], []);
  await f.poll();
  f.failNext();
  await f.poll();
  await f.assign("replacement");
  f.set(
    "completed",
    ["old"],
    [reply("old", "marker", 0, "[action required] old Assignment")],
  );
  await f.poll();
  assert.equal(f.confirmations.status.active, undefined);
  f.set(
    "completed",
    ["fresh", "old"],
    [reply("fresh", "marker", 1, "[action required] new Assignment")],
  );
  await f.poll();
  assert.ok(f.confirmations.status.active);
});

// Drive monitor timers independently of the real MCP transport's timeouts.
function clock(t) {
  let now = Math.ceil(performance.now());
  let scheduled;
  let polling;
  const clear = globalThis.clearTimeout;
  t.mock.method(performance, "now", () => now);
  t.mock.method(globalThis, "setTimeout", (callback, ms, ...args) => {
    if (callback.constructor.name !== "AsyncFunction")
      return realTimeout(callback, ms, ...args);
    assert.equal(scheduled, undefined);
    const timer = { due: now + ms, callback, unref() {} };
    scheduled = timer;
    return timer;
  });
  t.mock.method(globalThis, "clearTimeout", (timer) => {
    if (timer === scheduled) scheduled = undefined;
    else clear(timer);
  });
  function tick(ms) {
    now += ms;
    if (scheduled && scheduled.due <= now) {
      const { callback } = scheduled;
      scheduled = undefined;
      polling = callback();
      return true;
    }
    return false;
  }
  async function settle(f) {
    await f.releaseObservation();
    await until(() => scheduled !== undefined);
  }
  return {
    tick,
    settle,
    waitForPoll: () => polling,
    async observe(f, ms) {
      assert.ok(tick(ms), "Expected a fresh Thread observation");
      await settle(f);
    },
  };
}

test("replacement adopts an active Run discovered when a continuation invalidates the previous page", async (t) => {
  const time = clock(t);
  const f = await fixture(t);
  await f.assign("first");
  f.set(
    "completed",
    ["old"],
    [
      reply("old", "split", 0, "[action", {
        textTruncated: true,
        nextTextOffset: 7,
      }),
    ],
  );
  f.onContinuation(() =>
    f.set(
      "running",
      ["active", "old"],
      [],
      new Map([["split", reply("old", "split", 0, " required]")]]),
    ),
  );
  await time.observe(f, 5000);
  assert.ok(f.seen.some((args) => args.itemId === "split"));
  assert.equal(f.confirmations.status.active, undefined);
  await f.assign("replacement");
  f.set(
    "completed",
    ["active", "old"],
    [reply("active", "marker", 1, "[action required] adopted Run")],
  );
  await time.observe(f, 10000);
  assert.ok(f.confirmations.status.active);
});

test("recovers a missing handoff once, via Core queue delivery, after a full delay", async (t) => {
  const time = clock(t);
  const f = await fixture(t, {
    retryLimit: 1,
    handoffRecoveryDelaySeconds: 12,
  });
  await f.assign("first");
  f.set("completed", ["run"], [reply("run", "done", 0, "Done")]);
  await time.observe(f, 5000);
  await time.observe(f, 5000);
  await time.observe(f, 5000);
  time.tick(1999);
  assert.equal(f.sends.length, 1);
  await time.observe(f, 1);
  await until(() => f.sends.length === 2);
  await f.waitForRequests(1);
  assert.deepEqual(
    f.sends.map(({ threadId, mode, message }) => ({ threadId, mode, message })),
    [
      { threadId: "task", mode: "queue", message: "first" },
      { threadId: "task", mode: "queue", message: "continue" },
    ],
  );
});

test("a read begun before expiry cannot authorize recovery after expiry", async (t) => {
  const time = clock(t);
  const f = await fixture(t, { retryLimit: 1, handoffRecoveryDelaySeconds: 8 });
  await f.assign("first");
  f.set("completed", ["run"], []);
  await time.observe(f, 5000);
  assert.ok(time.tick(5000));
  time.tick(3000);
  await time.settle(f);
  assert.equal(f.requests.length, 0);
  // The expiry observation, not the earlier slow read, must authorize input.
  f.set("running", ["new", "run"], []);
  await time.observe(f, 0);
  assert.equal(f.sends.length, 1);
});

test("only completed and interrupted native statuses qualify for recovery", async (t) => {
  const time = clock(t);
  const f = await fixture(t, { handoffRecoveryDelaySeconds: 10 });
  await f.assign("first");
  for (const status of [
    "idle",
    "running",
    "failed",
    "cancelled",
    "rolled_back",
    "unknown",
  ]) {
    f.set(status, ["one"], []);
    await time.observe(f, 5000);
    await time.observe(f, 5000);
    await time.observe(f, 5000);
    assert.equal(f.requests.length, 0, status);
  }

  f.set("interrupted", ["one"], []);
  await time.observe(f, 5000);
  await time.observe(f, 5000);
  f.set("failed", ["one"], []);
  await time.observe(f, 5000);
  assert.equal(f.requests.length, 0);

  f.set("interrupted", ["one"], []);
  await time.observe(f, 5000);
  await time.observe(f, 5000);
  assert.equal(f.requests.length, 0);
  await time.observe(f, 5000);
  await until(() => f.sends.length === 2);
  await f.waitForRequests(1);
  assert.equal(f.requests.length, 1);
});

test("a changed Run ID with unchanged eligible status restarts the full recovery delay", async (t) => {
  const time = clock(t);
  const f = await fixture(t, {
    retryLimit: 1,
    handoffRecoveryDelaySeconds: 10,
  });
  await f.assign("first");
  f.set("completed", ["one"], []);
  await time.observe(f, 5000);
  f.set("completed", ["two", "one"], []);
  await time.observe(f, 5000);
  await time.observe(f, 5000);
  assert.equal(
    f.requests.length,
    0,
    "The old Run's deadline must not authorize recovery",
  );
  await time.observe(f, 5000);
  await until(() => f.sends.length === 2);
  await f.waitForRequests(1);
  assert.equal(f.requests.length, 1);
  assert.deepEqual(
    f.sends.map(({ threadId, mode, message }) => [threadId, mode, message]),
    [
      ["task", "queue", "first"],
      ["task", "queue", "continue"],
    ],
  );
});

test("a replacement without a new Run gets a full delay but cannot inherit the preceding marker", async (t) => {
  const time = clock(t);
  const f = await fixture(t, { retryLimit: 1, handoffRecoveryDelaySeconds: 8 });
  await f.assign("first");
  f.set(
    "completed",
    ["old"],
    [reply("old", "marker", 0, "[action required] old")],
  );
  await time.observe(f, 5000);
  assert.ok(f.confirmations.status.active);
  f.input.write("\n");
  await until(() => !f.confirmations.status.active);
  await time.observe(f, 5000);
  await f.assign("replacement");
  await time.observe(f, 5000);
  assert.equal(f.confirmations.status.active, undefined);
  await time.observe(f, 5000);
  assert.equal(f.requests.length, 0);
  await time.observe(f, 3000);
  await until(() => f.sends.length === 3);
  assert.equal(f.requests.length, 1);
  assert.deepEqual(
    f.sends.map(({ threadId, mode, message }) => [threadId, mode, message]),
    [
      ["task", "queue", "first"],
      ["task", "queue", "replacement"],
      ["task", "queue", "continue"],
    ],
  );
});

test("handoff appearance at expiry cancels recovery and observing existence resets the budget", async (t) => {
  const time = clock(t);
  const f = await fixture(t, { retryLimit: 1, handoffRecoveryDelaySeconds: 5 });
  const file = await f.assign("first");
  f.set("completed", ["run"], []);
  await time.observe(f, 5000);
  assert.ok(time.tick(5000));
  await writeFile(file, "{}");
  await time.settle(f);
  assert.equal(f.requests.length, 0);
  await unlink(file);
  await time.observe(f, 5000);
  assert.equal(f.requests.length, 0);
  await time.observe(f, 5000);
  await until(() => f.sends.length === 2);
  await f.waitForRequests(1);
  await time.observe(f, 5000);
  assert.equal(f.requests.length, 1);
  await writeFile(file, "{}");
  await time.observe(f, 5000);
  await unlink(file);
  await time.observe(f, 5000);
  assert.equal(f.requests.length, 1);
  await time.observe(f, 5000);
  await until(() => f.sends.length === 3);
  assert.equal(f.requests.length, 2);
});

test("a file-access error at expiry invalidates the delay until absence is confirmed again", async (t) => {
  const time = clock(t);
  const errors = t.mock.method(console, "error", () => {});
  const f = await fixture(t, { retryLimit: 1, handoffRecoveryDelaySeconds: 5 });
  const file = await f.assign("first");
  f.set("completed", ["run"], []);
  await time.observe(f, 5000);
  let inaccessible = true;
  const originalAccess = fs.access;
  const access = t.mock.method(fs, "access", async (path, ...args) => {
    if (path === file && inaccessible)
      throw Object.assign(new Error("Access denied"), { code: "EACCES" });
    return originalAccess(path, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    access.mock.restore();
    syncBuiltinESMExports();
  });
  await time.observe(f, 5000);
  assert.equal(f.requests.length, 0);
  assert.equal(time.tick(9999), false);
  await time.observe(f, 1);
  assert.equal(f.requests.length, 0);
  assert.deepEqual(
    errors.mock.calls.map(({ arguments: args }) => args[0]),
    ["Missing handoff recovery check failed; retrying in 10 seconds."],
  );
  inaccessible = false;
  await time.observe(f, 10000);
  assert.equal(f.requests.length, 0);
  await time.observe(f, 5000);
  await until(() => f.sends.length === 2);
  await f.waitForRequests(1);
});

test("an unavailable expiry observation cancels the delay; reconnect waits the full interval", async (t) => {
  const time = clock(t);
  const errors = t.mock.method(console, "error", () => {});
  const f = await fixture(t, { retryLimit: 2, handoffRecoveryDelaySeconds: 5 });
  await f.assign("first");
  f.set("completed", ["run"], []);
  await time.observe(f, 5000);
  await time.observe(f, 5000);
  await f.waitForRequests(1);
  f.set("completed", ["new", "run"], []);
  await time.observe(f, 5000);
  f.failNext(true);
  await time.observe(f, 5000);
  assert.equal(f.requests.length, 1);
  for (let retry = 0; retry < 3; retry++) {
    assert.equal(time.tick(9999), false);
    if (retry < 2) f.failNext();
    await time.observe(f, 1);
    assert.equal(f.requests.length, 1);
  }
  await time.observe(f, 5000);
  await f.waitForRequests(2);
  await time.observe(f, 5000);
  await time.observe(f, 5000);
  assert.equal(f.requests.length, 2);
  assert.equal(f.sends.length, 3);
  assert.deepEqual(
    errors.mock.calls.map(({ arguments: args }) => args[0]),
    [
      "Missing handoff recovery attempt 1/2.",
      "T3 observation lost; retrying in 10 seconds.",
      "T3 observation reconnect failed; retrying in 10 seconds.",
      "Missing handoff recovery attempt 2/2.",
      "Missing handoff recovery budget exhausted.",
    ],
  );
});

test("pausing at expiry cancels recovery and Enter waits again without restoring the attempt budget", async (t) => {
  const time = clock(t);
  const errors = t.mock.method(console, "error", () => {});
  const f = await fixture(t, { retryLimit: 2, handoffRecoveryDelaySeconds: 5 });
  await f.assign("first");
  f.set("completed", ["one"], []);
  await time.observe(f, 5000);
  await time.observe(f, 5000);
  await until(() => f.sends.length === 2);
  await f.waitForRequests(1);
  f.set("completed", ["two", "one"], []);
  await time.observe(f, 5000);
  f.set(
    "completed",
    ["two", "one"],
    [reply("two", "marker", 0, "[action required] wait")],
  );
  await time.observe(f, 5000);
  const confirmation = f.confirmations.status.active;
  assert.ok(confirmation);
  f.failNext(true);
  await time.observe(f, 5000);
  assert.equal(time.tick(9999), false);
  f.failNext();
  await time.observe(f, 1);
  assert.equal(time.tick(9999), false);
  await time.observe(f, 1);
  assert.deepEqual(f.confirmations.status.active, confirmation);
  assert.deepEqual(f.confirmations.status.pending, []);
  assert.equal(f.requests.length, 1);
  f.input.write("\n");
  await until(() => !f.confirmations.status.active);
  await time.observe(f, 5000);
  assert.equal(f.requests.length, 1);
  await time.observe(f, 5000);
  await until(() => f.sends.length === 3);
  await f.waitForRequests(2);
  f.set("interrupted", ["three", "two"], []);
  await time.observe(f, 5000);
  await time.observe(f, 5000);
  assert.equal(f.requests.length, 2);
  assert.equal(f.confirmations.status.active, undefined);
  assert.equal(
    errors.mock.calls.filter(({ arguments: args }) =>
      String(args[0]).includes("exhausted"),
    ).length,
    1,
  );
  await f.assign("replacement");
  await time.observe(f, 5000);
  await time.observe(f, 5000);
  await until(() => f.requests.length === 3);
  assert.notEqual(f.requests[2], f.requests[1]);
});

test("Core stale resolutions consume attempts and leave monitoring active", async (t) => {
  const time = clock(t);
  const f = await fixture(t, { retryLimit: 1, handoffRecoveryDelaySeconds: 0 });
  await f.assign("first");
  f.set("completed", ["run"], []);
  await time.observe(f, 5000);
  await f.complete();
  await time.observe(f, 0);
  assert.equal(f.requests.length, 1);
  await time.observe(f, 5000);
  await time.observe(f, 5000);
  assert.equal(f.requests.length, 1);
  assert.equal(f.sends.length, 1);
  assert.equal(f.confirmations.status.active, undefined);
});

test("an in-flight Core request settles without replay and a rejection disables recovery across replacements", async (t) => {
  const time = clock(t);
  const submission = Promise.withResolvers();
  const f = await fixture(
    t,
    { retryLimit: 3, handoffRecoveryDelaySeconds: 0 },
    () => submission.promise,
  );
  await f.assign("first");
  f.set("completed", ["run"], []);
  await time.observe(f, 5000);
  await time.observe(f, 0);
  assert.equal(f.requests.length, 1);
  f.failNext(true);
  await time.observe(f, 5000);
  assert.equal(time.tick(9999), false);
  f.failNext();
  await time.observe(f, 1);
  await f.assign("replacement");
  assert.equal(time.tick(9999), false);
  await time.observe(f, 1);
  await time.observe(f, 5000);
  assert.equal(f.requests.length, 1);
  submission.reject(new Error("Core rejected input"));
  await time.observe(f, 5000);
  await time.observe(f, 5000);
  assert.equal(f.requests.length, 1);
  f.set(
    "interrupted",
    ["new", "run"],
    [reply("new", "marker", 0, "[action required] still pause")],
  );
  await time.observe(f, 5000);
  assert.ok(f.confirmations.status.active);
});

for (const stop of ["Runner cancellation", "Enhancement stop"]) {
  test(`${stop} cancels a pending recovery and further observations`, async (t) => {
    const time = clock(t);
    const f = await fixture(t, { handoffRecoveryDelaySeconds: 5 });
    await f.assign("first");
    f.set("completed", ["run"], []);
    await time.observe(f, 5000);
    if (stop === "Runner cancellation") f.controller.abort();
    else await f.stopEnhancement();
    const reads = f.seen.length;
    assert.equal(time.tick(5000), false);
    assert.equal(time.tick(5000), false);
    assert.equal(f.seen.length, reads);
    assert.equal(f.requests.length, 0);
  });
}

for (const action of [
  "Runner cancellation",
  "Enhancement stop",
  "Assignment replacement",
]) {
  test(`${action} prevents further handoff checks after an in-progress check settles`, async (t) => {
    const time = clock(t);
    const f = await fixture(t, { handoffRecoveryDelaySeconds: 0 });
    const file = await f.assign("first");
    f.set(
      "completed",
      ["run"],
      [reply("run", "marker", 0, "[action required]")],
    );
    const pending = Promise.withResolvers();
    let accesses = 0;
    const originalAccess = fs.access;
    const access = t.mock.method(fs, "access", async (path, ...args) => {
      if (path === file && ++accesses === 1) await pending.promise;
      return originalAccess(path, ...args);
    });
    syncBuiltinESMExports();
    t.after(() => {
      access.mock.restore();
      syncBuiltinESMExports();
      pending.resolve();
    });

    assert.ok(time.tick(5000));
    await f.releaseObservation();
    await until(() => accesses === 1);
    if (action === "Runner cancellation") f.controller.abort();
    else if (action === "Enhancement stop") await f.stopEnhancement();
    else await f.assign("replacement");
    pending.resolve();
    await time.waitForPoll();

    assert.equal(accesses, 1);
    assert.equal(f.requests.length, 0);
    assert.equal(f.confirmations.status.active, undefined);
    if (action === "Assignment replacement") await time.observe(f, 5000);
    else assert.equal(time.tick(10000), false);
  });
}

test("default delay and retry budget are 120 seconds and three attempts", async (t) => {
  const time = clock(t);
  const f = await fixture(t, {});
  await f.assign("first");
  f.set("completed", ["run"], []);
  for (let attempt = 0; attempt < 3; attempt++) {
    await time.observe(f, 5000);
    await time.observe(f, 119999);
    assert.equal(f.requests.length, attempt);
    await time.observe(f, 1);
    await until(() => f.sends.length === attempt + 2);
    await f.waitForRequests(attempt + 1);
  }
  await time.observe(f, 5000);
  await time.observe(f, 120000);
  assert.equal(f.requests.length, 3);
  assert.equal(f.confirmations.status.active, undefined);
});

test("zero retry budget still allows Pause but never requests recovery", async (t) => {
  const time = clock(t);
  const f = await fixture(t, { retryLimit: 0, handoffRecoveryDelaySeconds: 0 });
  await f.assign("first");
  f.set("completed", ["run"], []);
  await time.observe(f, 5000);
  await time.observe(f, 5000);
  f.set("completed", ["run"], [reply("run", "marker", 0, "[action required]")]);
  await time.observe(f, 5000);
  assert.ok(f.confirmations.status.active);
  assert.equal(f.requests.length, 0);
});

test("recovery settings reject invalid values at the public factory", async (t) => {
  clock(t);
  const f = await fixture(t);
  const io = f.io;
  const context = {
    cwd: process.cwd(),
    env: {},
    enhancementPause: () => assert.fail("Unexpected pause"),
  };
  for (const value of [-1, 1.5, NaN, Infinity, "3", null]) {
    await assert.rejects(
      enhancement.createEnhancement(io, () => {}, context, {
        retryLimit: value,
      }),
      /retryLimit must be a nonnegative integer/,
    );
  }
  for (const value of [-1, NaN, Infinity, "120", null]) {
    await assert.rejects(
      enhancement.createEnhancement(io, () => {}, context, {
        handoffRecoveryDelaySeconds: value,
      }),
      /handoffRecoveryDelaySeconds must be finite nonnegative seconds/,
    );
  }
  for (const value of ["debug", "", false, null]) {
    await assert.rejects(
      enhancement.createEnhancement(io, () => {}, context, { logLevel: value }),
      /logLevel must be error or info/,
    );
  }
});

test("info logging reports recovery timer scheduling, cancellation and expiry", async (t) => {
  const time = clock(t);
  const errors = t.mock.method(console, "error", () => {});
  const f = await fixture(t, {
    retryLimit: 1,
    handoffRecoveryDelaySeconds: 10,
    logLevel: "info",
  });
  await f.assign("first");
  f.set("completed", ["run"], []);
  await time.observe(f, 5000);
  f.set("running", ["new", "run"], []);
  await time.observe(f, 5000);
  await time.observe(f, 5000);
  f.set("completed", ["new", "run"], []);
  await time.observe(f, 5000);
  await time.observe(f, 5000);
  await time.observe(f, 5000);
  await f.waitForRequests(1);
  assert.deepEqual(
    errors.mock.calls.map(({ arguments: args }) => args[0]),
    [
      "Missing handoff recovery timer scheduled.",
      "Missing handoff recovery timer cancelled.",
      "Missing handoff recovery timer scheduled.",
      "Missing handoff recovery timer expired.",
      "Missing handoff recovery attempt 1/1.",
      "Missing handoff recovery budget exhausted.",
    ],
  );
});

test("replacement during an expiry read cannot reuse the old delay", async (t) => {
  const time = clock(t);
  const f = await fixture(t, { retryLimit: 1, handoffRecoveryDelaySeconds: 5 });
  await f.assign("first");
  f.set("completed", ["run"], []);
  await time.observe(f, 5000);
  assert.ok(time.tick(5000));
  await f.assign("replacement");
  await time.settle(f);
  assert.equal(f.requests.length, 0);
  await time.observe(f, 5000);
  assert.equal(f.requests.length, 0);
  await time.observe(f, 5000);
  await until(() => f.sends.length === 3);
  assert.equal(f.requests.length, 1);
});

test("an in-flight request can settle after Enhancement stop without starting another request", async (t) => {
  const time = clock(t);
  const submission = Promise.withResolvers();
  const f = await fixture(
    t,
    { handoffRecoveryDelaySeconds: 0 },
    () => submission.promise,
  );
  await f.assign("first");
  f.set("completed", ["run"], []);
  await time.observe(f, 5000);
  await time.observe(f, 0);
  assert.equal(f.requests.length, 1);
  f.failNext(true);
  await time.observe(f, 5000);
  assert.equal(time.tick(9999), false);
  await f.stopEnhancement();
  submission.resolve();
  await f.waitForRequests(1);
  assert.equal(time.tick(10000), false);
  assert.equal(f.requests.length, 1);
});

test("fractional seconds are valid and require a fresh expiry observation", async (t) => {
  const time = clock(t);
  const f = await fixture(t, {
    retryLimit: 1,
    handoffRecoveryDelaySeconds: 0.25,
  });
  await f.assign("first");
  f.set("completed", ["run"], []);
  await time.observe(f, 5000);
  assert.equal(time.tick(249), false);
  assert.equal(f.requests.length, 0);
  await time.observe(f, 1);
  await until(() => f.sends.length === 2);
  assert.equal(f.requests.length, 1);
});
