import assert from "node:assert/strict";
import { contractVersion, createEnhancement } from "issue-runner-agent-t3";
const { createT3Terminal } = await import(
  new URL("./terminal.js", import.meta.resolve("issue-runner-agent-t3"))
);

const [endpoint] = process.argv.slice(2);
assert.equal(contractVersion, 3);
const terminal = await createT3Terminal(endpoint, "launcher");
const options = { cwd: process.cwd(), env: {}, submitKey: "Enter" };
const fresh = await terminal.createTab({ ...options, label: "fresh" });
const resumed = await terminal.createTab({ ...options, label: "resumed" });
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
a.onAssignment({ id: "fresh-assignment", expectedFile: "fresh.json" });
b.onAssignment({ id: "resumed-assignment", expectedFile: "resumed.json" });
await Promise.all([
  fresh.io.submitText("Assignment"),
  resumed.io.submitText("continue"),
]);
await a.stop();
assert.equal(await b.waitUntilReady(), "saved-thread");
await b.stop();
