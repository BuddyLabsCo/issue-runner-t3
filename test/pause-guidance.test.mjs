import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import {
  setImmediate as turn,
  setTimeout as delay,
} from "node:timers/promises";
import { test } from "node:test";
import { TerminalOperator } from "../node_modules/issue-runner-core/dist/adapters/terminal.js";
import { TerminalConfirmations } from "../node_modules/issue-runner-core/dist/run/confirmations.js";
import { pauseForOperator } from "../node_modules/issue-runner-core/dist/run/operations.js";
import { restartUnrecoverable } from "../node_modules/issue-runner-core/dist/run/execution-recovery.js";
import { startPauseGuidance } from "../dist/pause-guidance.js";
import { saveCredential } from "../dist/credentials.js";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const template = `Issue Runner is running in this conversation's terminal.\n\nInvestigate this Runner Pause. Explain its cause and recommend the next action and confirmation option. Diagnose only; do not take action.\n\nRecent Runner output:\n<output>\n`;
const retryMessage =
  "Cannot read issue. Enter to retry, q/EOF to cancel. Other input is unsupported.";
const enhancementMessage =
  "[Enhancement Pause] issue #42: Awaiting operator\nEnter to continue. Other input is unsupported.";

async function until(predicate) {
  for (let i = 0; i < 750; i++) {
    if (predicate()) return;
    await delay(20);
  }
  assert.fail("Timed out waiting for guidance");
}

async function fixture(t, tty, respond = () => ({}), enabled = undefined) {
  const home = await mkdtemp(join(tmpdir(), "pause-guidance-"));
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
  const calls = [];
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.headers.authorization, "Bearer guidance-fixture-token");
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      let body = "";
      for await (const chunk of req) body += chunk;
      const rpc = JSON.parse(body);
      const json = (result) =>
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
      if (rpc.method === "initialize") {
        json({
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "test", version: "1" },
        });
      } else if (rpc.method === "notifications/initialized") {
        res.writeHead(202).end();
      } else {
        assert.equal(rpc.method, "tools/call");
        assert.equal(rpc.params.name, "t3_thread_send");
        calls.push(rpc.params.arguments);
        const extra = await respond(calls.length);
        json({
          structuredContent: {
            threadId: "launcher",
            runId: "queued-run",
            messageId: "queued-message",
            delivery: "queued",
            ...extra,
          },
          content: [],
        });
      }
    } catch (error) {
      res.writeHead(500).end(String(error));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  const endpoint = `http://127.0.0.1:${server.address().port}/mcp`;
  await saveCredential(endpoint, {
    accessToken: "guidance-fixture-token",
    expiresAt: Date.now() + 120_000,
    scope: "orchestration:operate",
  });
  const input = new PassThrough();
  const output = new PassThrough();
  output.isTTY = tty;
  let rendered = "";
  output.on("data", (chunk) => {
    rendered += chunk;
  });
  const write = output.write;
  const controller = new AbortController();
  const operator = new TerminalOperator(controller.signal, { input, output });
  const stop = startPauseGuidance(endpoint, "launcher", enabled, {
    input,
    output,
  });
  t.after(() => {
    stop();
    controller.abort();
    input.destroy();
    output.destroy();
  });
  return {
    input,
    output,
    operator,
    queue: new TerminalConfirmations(operator, controller.signal),
    calls,
    stop,
    write,
    rendered: () => rendered,
  };
}

for (const tty of [false, true]) {
  test(`Core confirmation guidance preserves FIFO identity (TTY=${tty})`, async (t) => {
    const { input, operator, queue, calls, rendered } = await fixture(t, tty);
    for (let i = 0; i < 20; i++)
      operator.write(`line ${i}: ${i === 19 ? "x".repeat(20000) : ""}`);
    const first = queue.request({
      id: "first",
      message: retryMessage,
      accepts: (value) => value === "" || value === "q",
    });
    await until(() => calls.length === 1);
    assert.deepEqual(calls[0], {
      threadId: "launcher",
      mode: "queue",
      clientRequestId: calls[0].clientRequestId,
      message: template.replace("<output>", () =>
        rendered().split("\n").slice(-15).join("\n"),
      ),
    });
    assert.match(calls[0].clientRequestId, /^[0-9a-f-]{36}$/);
    const second = queue.request({
      id: "second",
      message: retryMessage,
      accepts: (value) => value === "",
    });
    const cancelled = new AbortController();
    const discarded = queue.request({
      id: "discarded",
      message:
        "[Enhancement Pause] discarded\nEnter to continue. Other input is unsupported.",
      accepts: (value) => value === "",
      signal: cancelled.signal,
    });
    const rejection = assert.rejects(discarded);
    const third = queue.request({
      id: "third",
      message: enhancementMessage,
      accepts: (value) => value === "",
    });
    cancelled.abort();
    await rejection;
    operator.write("ordinary redraw");
    input.write("invalid\n");
    await until(() => rendered().includes("Unsupported input."));
    await turn();
    assert.equal(calls.length, 1);
    input.write("\n");
    assert.equal(await first, "");
    await until(() => calls.length === 2);
    assert.notEqual(calls[1].clientRequestId, calls[0].clientRequestId);
    assert.match(calls[1].message, /Cannot read issue/);
    input.write("\n");
    assert.equal(await second, "");
    await until(() => calls.length === 3);
    assert.match(calls[2].message, /\[Enhancement Pause\] issue #42/);
    input.write("q\n");
    await turn();
    assert.equal(calls.length, 3);
    input.write("\n");
    assert.equal(await third, "");
    for (const scope of ["Issue #42", "Documentation Maintenance"]) {
      const restart = restartUnrecoverable(operator, scope);
      await until(() => calls.length === (scope === "Issue #42" ? 4 : 5));
      assert.ok(
        calls
          .at(-1)
          .message.includes(
            `Enter to restart the entire ${scope}, or q to exit Runner.`,
          ),
      );
      input.write("\n");
      await restart;
    }
    const pause = pauseForOperator(operator, "Unscoped operation failed.");
    await until(() => calls.length === 6);
    assert.match(
      calls.at(-1).message,
      /Unscoped operation failed\. Enter to retry/,
    );
    input.write("\n");
    await pause;
    operator.write("[Enhancement Pause ended] issue #42: done");
    operator.write(retryMessage);
    operator.write("> ");
    await turn();
    assert.equal(calls.length, 6);
  });
}

for (const tty of [false, true]) {
  test(`confirmation ended before dispatch or Run exit sends nothing (TTY=${tty})`, async (t) => {
    const { input, output, operator, calls, stop, write } = await fixture(
      t,
      tty,
    );
    const beforeDispatch = operator.pause(retryMessage);
    input.write("\n");
    assert.equal(await beforeDispatch, "");
    await turn();
    assert.equal(calls.length, 0);
    const onExit = operator.pause(retryMessage);
    stop();
    assert.equal(output.write, write);
    input.write("\n");
    assert.equal(await onExit, "");
    await turn();
    assert.equal(calls.length, 0);
  });
}

test("uncertain delivery retries with the same request and stops when the confirmation ends", async (t) => {
  const { input, operator, calls } = await fixture(t, false, (count) =>
    count === 2 ? {} : { code: "orchestration_error", message: "uncertain" },
  );
  const first = operator.pause(retryMessage);
  await until(() => calls.length === 2);
  assert.deepEqual(calls[0], calls[1]);
  input.write("\n");
  assert.equal(await first, "");
  const second = operator.pause(retryMessage);
  await until(() => calls.length === 3);
  assert.notEqual(calls[2].clientRequestId, calls[0].clientRequestId);
  input.end();
  assert.equal(await second, null);
  await delay(5200);
  assert.equal(calls.length, 3);
});

test("delivery rejection is logged once; accepted or late advice cannot answer a confirmation", async (t) => {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const { input, operator, queue, calls } = await fixture(t, true, (count) =>
    count === 1
      ? { code: "rejected", message: "Delivery unavailable" }
      : count === 2
        ? held
        : {},
  );
  const errors = [];
  t.mock.method(console, "error", (message) => errors.push(message));
  const first = operator.pause(retryMessage);
  await until(() => errors.length === 1);
  assert.match(
    errors[0],
    /Pause guidance delivery failed: Delivery unavailable/,
  );
  operator.write("redraw after failure");
  await turn();
  assert.equal(calls.length, 1);
  input.write("q\n");
  assert.equal(await first, "q");
  const second = queue.request({
    id: "second",
    message: enhancementMessage,
    accepts: (value) => value === "",
  });
  await until(() => calls.length === 2);
  input.write("\n");
  assert.equal(await second, "");
  let thirdAnswered = false;
  const third = queue
    .request({
      id: "third",
      message: enhancementMessage,
      accepts: (value) => value === "",
    })
    .then((value) => {
      thirdAnswered = true;
      return value;
    });
  await until(() => calls.length === 3);
  release({ reply: "Enter" });
  await turn();
  assert.equal(thirdAnswered, false);
  input.write("\n");
  assert.equal(await third, "");
  assert.equal(errors.length, 1);
});

test("disabled guidance validates configuration without observing streams", async (t) => {
  const input = new PassThrough();
  const output = new PassThrough();
  const original = output.write;
  const listeners = t.mock.method(input, "listeners", () =>
    assert.fail("stdin must not be inspected"),
  );
  for (const invalid of [null, 0, "false", {}]) {
    assert.throws(
      () =>
        startPauseGuidance("unused", "launcher", invalid, { input, output }),
      /terminalPlugins\.pauseGuidance must be a boolean/,
    );
  }
  const stop = startPauseGuidance("unused", "launcher", false, {
    input,
    output,
  });
  assert.equal(output.write, original);
  const operator = new TerminalOperator(undefined, { input, output });
  const waiting = operator.pause(retryMessage);
  input.write("\n");
  assert.equal(await waiting, "");
  stop();
  assert.equal(output.write, original);
  assert.equal(listeners.mock.callCount(), 0);
  assert.equal(input.listenerCount("removeListener"), 0);
  input.destroy();
  output.destroy();
});
