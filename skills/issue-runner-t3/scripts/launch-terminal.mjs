import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

const positiveIssue = value => /^[1-9]\d*$/.test(value ?? '') && Number.isSafeInteger(Number(value));

function runnerCommand(projectKey, args) {
  if (!/^[A-Za-z0-9._-]+$/.test(projectKey ?? '') || ['.', '..'].includes(projectKey)) {
    throw new Error('Invalid Project key.');
  }
  const noMerge = args.at(-1) === '--no-auto-merge';
  const [selector, number, ...rest] = noMerge ? args.slice(0, -1) : args;
  const valid = selector === '--document' && number === undefined ||
    selector === '--issue' && number === undefined && !noMerge ||
    (selector === '--issue' || selector === '--parent' && !noMerge) && positiveIssue(number) && rest.length === 0;
  if (!valid) throw new Error('Use --issue [number], --parent <number>, or --document. --no-auto-merge requires a numbered --issue or --document.');
  return `issue-runner-t3 run --project=${projectKey} ${args.join(' ')}`;
}

function waitFor(socket, event, select, send) {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const options = { signal: controller.signal };
    const finish = (fn, value) => {
      clearTimeout(timer);
      controller.abort();
      fn(value);
    };
    const fail = () => finish(reject, new Error('T3 WebSocket did not acknowledge the request.'));
    const timer = setTimeout(fail, 10_000);
    socket.addEventListener('error', fail, options);
    socket.addEventListener('close', fail, options);
    socket.addEventListener(event, message => {
      try {
        const value = select(message);
        if (value !== undefined) finish(resolve, value);
      } catch { fail(); }
    }, options);
    try { send?.(); } catch { fail(); }
  });
}

// T3 v0.1.11's internal Effect RPC protocol is JSON over an authenticated WebSocket.
async function rpc(socket, id, tag, payload) {
  const exit = await waitFor(socket, 'message', event => {
    const message = JSON.parse(event.data);
    return message._tag === 'Exit' && message.requestId === id ? message.exit : undefined;
  }, () => socket.send(JSON.stringify({ _tag: 'Request', id, tag, payload, headers: [] })));
  if (exit._tag !== 'Success') throw new Error(`${tag} was rejected by T3.`);
  return exit.value;
}

async function main() {
  const [threadId, launchDirectory, projectKey, ...selector] = process.argv.slice(2);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(threadId ?? '') || !launchDirectory || !isAbsolute(launchDirectory)) {
    throw new Error('Usage: launch-terminal.mjs <threadId> <launchDirectory> <projectKey> <selector> [--no-auto-merge]');
  }
  const command = runnerCommand(projectKey, selector);
  const cwd = realpathSync(launchDirectory);
  if (!statSync(join(cwd, projectKey, 'config.yaml')).isFile()) throw new Error('Project config.yaml is missing.');

  const baseDir = resolve(process.env.T3CODE_HOME || join(homedir(), '.t3'));
  let origin;
  try {
    const runtime = JSON.parse(readFileSync(join(baseDir, 'userdata', 'server-runtime.json'), 'utf8'));
    origin = new URL(runtime.origin);
    if (origin.hostname === '0.0.0.0') origin.hostname = '127.0.0.1';
    if (origin.hostname === '[::]') origin.hostname = '[::1]';
    if (!['http:', 'https:'].includes(origin.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) || origin.username || origin.password) throw new Error();
  } catch {
    throw new Error('Cannot locate the local T3 Server. Check T3CODE_HOME and that T3 is running.');
  }

  const t3 = args => execFileSync('t3', args, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000,
    cwd: baseDir, env: { ...process.env, T3CODE_HOME: baseDir }, shell: process.platform === 'win32',
  });
  try { t3(['thread', 'show', threadId, '--json', '--messages', '0']); }
  catch { throw new Error('Cannot find the current thread on the local T3 Server.'); }
  let token;
  try { token = t3(['auth', 'session', 'issue', '--scope', 'terminal:operate', '--ttl', '5m', '--token-only']).trim(); }
  catch { throw new Error('T3 could not issue a terminal session.'); }
  if (!token) throw new Error('T3 did not issue a terminal session.');

  let ticket;
  try {
    const response = await fetch(new URL('/api/auth/websocket-ticket/rpc', origin), {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'x-t3-orchestration-protocol': '2' },
      redirect: 'error', signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error();
    ({ ticket } = await response.json());
    if (typeof ticket !== 'string' || !ticket) throw new Error();
  } catch { throw new Error('T3 rejected terminal authorization.'); }

  const url = new URL('/ws', origin);
  url.protocol = origin.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('orchestrationProtocol', '2');
  url.searchParams.set('wsTicket', ticket);
  let socket;
  try { socket = new WebSocket(url); }
  catch { throw new Error('Cannot connect to the T3 WebSocket.'); }
  const terminalId = `issue-runner-${randomUUID()}`;
  try {
    await waitFor(socket, 'open', () => true);
    const opened = await rpc(socket, '1', 'terminal.open', { threadId, terminalId, cwd, stopOnSettle: false });
    if (opened?.threadId !== threadId || opened.terminalId !== terminalId || opened.status !== 'running' || realpathSync(opened.cwd) !== cwd) {
      throw new Error('T3 did not open the expected terminal.');
    }
    try { await rpc(socket, '2', 'terminal.write', { threadId, terminalId, data: `${command}\r` }); }
    catch { throw new Error(`Runner command was not acknowledged. Inspect the terminal before retrying (${terminalId}).`); }
    console.log(`Runner command sent to T3 terminal ${terminalId}.`);
  } finally { socket.close(); }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
