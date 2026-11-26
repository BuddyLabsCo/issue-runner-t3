import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
  let unavailable = false;
  const seen = [];
  const server = await substitute(async (name, args, authorization) => {
    assert.equal(authorization, `Bearer ${server.token}`);
    if (name === "t3_thread_read") {
      if (args.threadId === "task") seen.push(args);
      if (args.view === "messages") {
        if (!args.itemId && args.beforePosition === undefined) {
          pending = Promise.withResolvers();
          await pending.promise;
          if (unavailable) {
            unavailable = false;
            return { code: "orchestration_error", message: "Unavailable" };
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
    if (name === "t3_thread_send")
      return {
        threadId: "task",
        runId: "receipt",
        messageId: "receipt-message",
      };
    if (name === "t3_queue") return { items: [], nextCursor: null };
    if (name === "t3_thread_organize") return { sequence: 1 };
    assert.fail(`Unexpected tool ${name}`);
  });
  return {
    server,
    release: () => pending?.resolve(),
    seen,
    onContinuation(update) {
      nextContinuation = update;
    },
    failNext() {
      unavailable = true;
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

async function fixture(t) {
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
  const tab = await conversations.create(
    { cwd: home, env: {}, label: "task", submitKey: "Enter" },
    enhancement,
    {},
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
    input,
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
