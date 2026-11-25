import assert from "node:assert/strict";
import { createT3Terminal } from "../../dist/terminal.js";

const [endpoint, expectedError] = process.argv.slice(2);
const terminal = await createT3Terminal(endpoint, "launcher");
const { handle, io } = await terminal.createTab({
  cwd: process.cwd(),
  env: {},
  label: "issue-42 fix review r1",
  submitKey: "Enter",
});
if (expectedError) {
  await assert.rejects(
    terminal.execute(handle, "t3 resume saved-thread"),
    (error) => {
      assert.match(error.message, new RegExp(expectedError, "i"));
      assert.match(error.message, /\bq\b/);
      return true;
    },
  );
  await assert.rejects(io.submitText("must not deliver"), /not bound/);
  await terminal.closeTab(handle);
} else {
  assert.equal(
    await terminal.execute(handle, "t3 resume saved-thread"),
    "saved-thread",
  );
  await io.submitText("Review fix");
}
