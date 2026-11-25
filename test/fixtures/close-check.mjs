import assert from "node:assert/strict";
import { createT3Terminal } from "../../dist/terminal.js";

const [endpoint, ...errors] = process.argv.slice(2);
const terminal = await createT3Terminal(endpoint, "launcher");
const { handle } = await terminal.createTab({
  cwd: process.cwd(),
  env: {},
  label: "test",
  submitKey: "Enter",
});
assert.equal(
  await terminal.execute(handle, "t3 start --provider codex --model test"),
  "task",
);
for (const error of errors)
  await assert.rejects(terminal.closeTab(handle), new RegExp(error));
await terminal.closeTab(handle);
await assert.rejects(terminal.closeTab(handle), /Unknown T3 task handle/);
