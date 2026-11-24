import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { createT3Terminal } from '../../dist/terminal.js';

const [endpoint, handoff] = process.argv.slice(2);
const terminal = await createT3Terminal(endpoint, 'launcher');
const { handle, io } = await terminal.createTab({ cwd: process.cwd(), env: {}, label: 'test', submitKey: 'Enter' });
assert.equal(await terminal.execute(handle, 't3 start --provider codex --model test'), 'task');
await io.submitText(`Handoff path: ${handoff}`);
await assert.rejects(stat(handoff), { code: 'ENOENT' });
await assert.rejects(terminal.closeTab(handle), /Cannot archive a T3 thread/);
