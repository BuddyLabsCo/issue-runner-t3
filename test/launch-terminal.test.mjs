import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../skills/issue-runner-t3/scripts/launch-terminal.mjs', import.meta.url));
const substitute = fileURLToPath(new URL('./fixtures/terminal-rpc-substitute.mjs', import.meta.url));

async function fixture(t) {
  const root = await mkdtemp(resolve('.test-terminal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const launch = join(root, "Runner's Projects");
  await mkdir(join(launch, 'demo'), { recursive: true });
  await writeFile(join(launch, 'demo', 'config.yaml'), 'repository: fixture/demo\n');
  await mkdir(join(root, 'userdata'));
  await writeFile(join(root, 'userdata', 'server-runtime.json'), JSON.stringify({ origin: 'http://127.0.0.1:4242' }));
  const log = join(root, 'rpc.log');
  const run = (args, mode = '') => spawnSync(process.execPath, ['--import', substitute, script, 'current-thread', launch, 'demo', ...args], {
    env: { ...process.env, T3CODE_HOME: root, RPC_LOG: log, RPC_MODE: mode }, encoding: 'utf8', timeout: 5000,
  });
  return { launch, run, calls: async () => (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse) };
}

test('skill launcher opens a new terminal in the current thread and starts Runner', async t => {
  const { launch, run, calls } = await fixture(t);
  const result = run(['--issue', '42', '--no-auto-merge']);
  assert.equal(result.status, 0, result.stderr);
  const messages = await calls();
  const [read, auth, ticket, open, write, close] = messages;
  assert.deepEqual(read.args, ['thread', 'show', 'current-thread', '--json', '--messages', '0']);
  assert.equal(auth.args[0], 'auth');
  assert.equal(ticket.ticket, true);
  assert.equal(open.tag, 'terminal.open');
  assert.equal(open.payload.threadId, 'current-thread');
  assert.equal(open.payload.cwd, launch);
  assert.equal(open.payload.stopOnSettle, false);
  assert.equal(write.tag, 'terminal.write');
  assert.deepEqual(write.payload, { threadId: 'current-thread', terminalId: open.payload.terminalId, data: 'issue-runner-t3 run --project=demo --issue 42 --no-auto-merge\r' });
  assert.deepEqual(close, { closed: true });
  assert.doesNotMatch(result.stdout + result.stderr, /fixture-token|fixture-ticket/);
});

test('skill launcher stops when T3 opens the wrong thread or fails to start the shell', async t => {
  for (const mode of ['wrong-thread', 'failed-open']) {
    await t.test(mode, async t => {
      const { run, calls } = await fixture(t);
      const result = run(['--document'], mode);
      assert.notEqual(result.status, 0);
      assert.ok((await calls()).some(call => call.tag === 'terminal.open'));
      assert.ok(!(await calls()).some(call => call.tag === 'terminal.write'));
    });
  }
});

test('skill launcher supports every Runner selector', async t => {
  for (const selector of [['--issue'], ['--parent', '42'], ['--document', '--no-auto-merge']]) {
    await t.test(selector.join(' '), async t => {
      const { run, calls } = await fixture(t);
      const result = run(selector);
      assert.equal(result.status, 0, result.stderr);
      const write = (await calls()).find(call => call.tag === 'terminal.write');
      assert.equal(write.payload.data, `issue-runner-t3 run --project=demo ${selector.join(' ')}\r`);
    });
  }
});

test('skill launcher never resends an unacknowledged or rejected command', async t => {
  const { run, calls } = await fixture(t);
  const result = run(['--parent', '42'], 'reject-write');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /inspect the terminal before retrying/i);
  assert.equal((await calls()).filter(call => call.tag === 'terminal.write').length, 1);
});

test('invalid Runner selectors are refused before requesting credentials', async t => {
  const { run, calls } = await fixture(t);
  for (const selector of [['--issue', '--no-auto-merge'], ['--parent', '42', '--no-auto-merge'], ['--issue', '0'], ['--issue', '42', ';', 'echo']]) {
    assert.notEqual(run(selector).status, 0);
  }
  await assert.rejects(calls(), { code: 'ENOENT' });
});
