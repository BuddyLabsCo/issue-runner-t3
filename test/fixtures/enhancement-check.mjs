import assert from "node:assert/strict";
import { contractVersion, createEnhancement } from "issue-runner-agent-t3";
const { boundTabs, createT3Terminal } = await import(
  new URL("./terminal.js", import.meta.resolve("issue-runner-agent-t3"))
);

const [endpoint] = process.argv.slice(2);
assert.equal(contractVersion, 3);
const terminal = await createT3Terminal(endpoint, "launcher");
const options = { cwd: process.cwd(), env: {}, submitKey: "Enter" };
const fresh = await terminal.createTab({ ...options, label: "fresh" });
const resumed = await terminal.createTab({ ...options, label: "resumed" });
const freshState = boundTabs.get(fresh.io);
const resumedState = boundTabs.get(resumed.io);
assert.notEqual(freshState, resumedState);
for (const state of [freshState, resumedState]) {
  assert.equal(state.endpoint, endpoint);
  assert.equal(state.threadId, undefined);
  assert.deepEqual(state.receipts, []);
}
const context = {
  cwd: options.cwd,
  env: {},
  enhancementPause: () => assert.fail("Unexpected pause"),
};
const recovery = () => assert.fail("Unexpected recovery");
const a = await createEnhancement(fresh.io, recovery, context, {});
const b = await createEnhancement(resumed.io, recovery, context, {});
assert.notEqual(a, b);
await a.startMonitoring();
await b.startMonitoring("saved-thread");
await assert.rejects(a.waitUntilReady(), /not bound/);
await assert.rejects(b.waitUntilReady(), /not bound/);
assert.equal(
  await terminal.execute(resumed.handle, "t3 resume saved-thread"),
  "saved-thread",
);
assert.equal(
  await terminal.execute(
    fresh.handle,
    "t3 start --provider codex --model test",
  ),
  "fresh-thread",
);
assert.equal(await b.waitUntilReady(), "saved-thread");
assert.equal(await a.waitUntilReady(), "fresh-thread");
assert.equal(freshState.threadId, "fresh-thread");
assert.equal(resumedState.threadId, "saved-thread");
a.onAssignment({ id: "fresh-assignment", expectedFile: "fresh.json" });
b.onAssignment({ id: "resumed-assignment", expectedFile: "resumed.json" });
const freshReceipt = {
  threadId: "fresh-thread",
  runId: "fresh-run-1",
  messageId: "fresh-message-1",
};
const retriedReceipt = {
  threadId: "fresh-thread",
  runId: "fresh-run-2",
  messageId: "fresh-message-2",
};
const resumedReceipt = {
  threadId: "saved-thread",
  runId: "saved-run-1",
  messageId: "saved-message-1",
};
await fresh.io.submitText("Assignment");
assert.deepEqual(freshState.receipts, [freshReceipt]);
assert.deepEqual(resumedState.receipts, []);
await resumed.io.submitText("continue");
await fresh.io.submitText("retry");
assert.deepEqual(freshState.receipts, [freshReceipt, retriedReceipt]);
assert.deepEqual(resumedState.receipts, [resumedReceipt]);
await assert.rejects(
  resumed.io.submitText("rejected"),
  /Retry budget exhausted/,
);
assert.deepEqual(freshState.receipts, [freshReceipt, retriedReceipt]);
assert.deepEqual(resumedState.receipts, [resumedReceipt]);
await a.stop();
await terminal.closeTab(fresh.handle);
assert.equal(freshState.threadId, undefined);
assert.deepEqual(freshState.receipts, []);
assert.equal(resumedState.endpoint, endpoint);
assert.equal(resumedState.threadId, "saved-thread");
assert.deepEqual(resumedState.receipts, [resumedReceipt]);
assert.equal(await b.waitUntilReady(), "saved-thread");
await b.stop();
