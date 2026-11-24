import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { chmod, mkdtemp, mkdir, readFile, readdir, stat, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { parse } from 'yaml';

let root, home, launch, bin;
before(async () => {
  root = await mkdtemp(resolve('.test-'));
  // npm 11 exports global allow-scripts settings to lifecycle children, but scoped installs reject that flag.
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'npm_config_allow_scripts') delete env[key];
  const options = { env, encoding: 'utf8' };
  const npm = args => process.env.npm_execpath
    ? execFileSync(process.execPath, [process.env.npm_execpath, ...args], options)
    : execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { ...options, shell: process.platform === 'win32' });
  const [pack] = JSON.parse(npm(['pack', '--ignore-scripts', '--json', '--pack-destination', root]));
  npm(['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', join(root, 'install'), join(root, pack.filename)]);
  bin = process.platform === 'win32'
    ? join(root, 'install', 'node_modules', 'issue-runner-t3', 'dist', 'cli.js')
    : join(root, 'install', 'node_modules', '.bin', 'issue-runner-t3');
  if (process.platform === 'win32') await stat(join(root, 'install', 'node_modules', '.bin', 'issue-runner-t3.cmd'));
});
beforeEach(async () => {
  home = await mkdtemp(join(root, 'home-'));
  launch = await mkdtemp(join(root, 'launch-'));
});
after(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

function cli(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.platform === 'win32' ? process.execPath : bin, process.platform === 'win32' ? [bin, ...args] : args, {
      cwd: options.cwd ?? launch,
      env: { ...process.env, HOME: home, USERPROFILE: home, BROWSER: process.execPath },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: options.timeout ?? 30_000,
    });
    let output = '';
    let approved = false;
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const url = output.match(/Approve access: (https?:\/\/[^\s]+)\n/)?.[1];
      if (url && options.approve && !approved) {
        approved = true;
        options.approve(url).catch(error => { child.kill(); reject(error); });
      }
    });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, output }));
  });
}

test('installed CLI offers help and version without credentials', async () => {
  const help = await cli(['--help']);
  assert.equal(help.code, 0, help.output);
  assert.match(help.output, /auth login/);
  assert.match(help.output, /init --project/);
  const authHelp = await cli(['auth', '--help']);
  assert.equal(authHelp.code, 0);
  assert.match(authHelp.output, /Default MCP URL: http:\/\/127\.0\.0\.1:3773\/mcp/);
  const version = await cli(['--version']);
  assert.equal(version.code, 0, version.output);
  assert.match(version.output, /issue-runner-t3 .*core 1\.0\.10/);
});

async function substitute() {
  const token = `disposable-${randomUUID()}`;
  const state = { scope: 'orchestration:read orchestration:operate', expires: 3600, reject: false, reads: 0, readError: false, stallInitialized: false, stalled: 0 };
  let registration, authorization;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, endpoint);
    let body = '';
    for await (const chunk of req) body += chunk;
    const json = (data, code = 200) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    try {
      if (url.pathname === '/oauth/mcp/register') {
        registration = JSON.parse(body);
        assert.equal(registration.client_name, 'issue-runner-t3');
        return json({ client_id: 'test-client' }, 201);
      }
      if (url.pathname === '/oauth/mcp/authorize') {
        authorization = url.searchParams;
        assert.equal(authorization.get('client_id'), 'test-client');
        assert.equal(authorization.get('code_challenge_method'), 'S256');
        assert.match(authorization.get('scope'), /orchestration:operate/);
        assert.equal(authorization.get('resource'), endpoint);
        assert.equal(authorization.get('redirect_uri'), registration.redirect_uris[0]);
        const redirect = new URL(authorization.get('redirect_uri'));
        assert.equal(redirect.hostname, '127.0.0.1');
        redirect.searchParams.set('code', 'test-code');
        redirect.searchParams.set('state', authorization.get('state'));
        redirect.searchParams.set('iss', url.origin);
        res.writeHead(302, { Location: redirect.href });
        return res.end();
      }
      if (url.pathname === '/oauth/mcp/token') {
        const params = new URLSearchParams(body);
        assert.equal(params.get('code'), 'test-code');
        assert.equal(params.get('grant_type'), 'authorization_code');
        assert.equal(params.get('client_id'), 'test-client');
        assert.equal(params.get('redirect_uri'), registration.redirect_uris[0]);
        assert.equal(params.get('resource'), endpoint);
        assert.equal(createHash('sha256').update(params.get('code_verifier')).digest('base64url'), authorization.get('code_challenge'));
        return json({ access_token: token, expires_in: state.expires, token_type: 'Bearer', scope: state.scope });
      }
      assert.equal(url.pathname, '/mcp');
      if (state.reject || req.headers.authorization !== `Bearer ${token}`) {
        return json({ error: 'invalid_token', detail: token }, 401);
      }
      if (req.method === 'GET' || req.method === 'DELETE') { res.writeHead(405); return res.end(); }
      const rpc = JSON.parse(body);
      if (rpc.method === 'initialize') {
        return json({ jsonrpc: '2.0', id: rpc.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'T3 substitute', version: '0.1.11' } } });
      }
      if (rpc.method === 'notifications/initialized') {
        if (state.stallInitialized) { state.stalled++; return; }
        res.writeHead(202); return res.end();
      }
      assert.equal(rpc.method, 'tools/call');
      assert.equal(rpc.params.name, 't3_project_list');
      state.reads++;
      if (state.readError) return json({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: JSON.stringify({ error: token }) }] } });
      return json({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: '{"projects":[],"nextCursor":null}' }] } });
    } catch (error) {
      json({ error: error.message }, 500);
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const endpoint = `http://127.0.0.1:${server.address().port}/mcp`;
  return { endpoint, token, state, close: () => new Promise(resolve => server.close(resolve)) };
}

const approve = async url => {
  const response = await fetch(url);
  assert.equal(response.status, 200);
};

test('custom-only browser login, status, and init use the Core templates and retain the endpoint', async () => {
  const server = await substitute();
  try {
    const initArgs = ['init', '--project', 'authorized', '--mcp-url', `${server.endpoint}/`];
    const unauthorized = await cli(initArgs);
    assert.notEqual(unauthorized.code, 0);
    assert.ok(unauthorized.output.includes(`auth login ${server.endpoint}`), unauthorized.output);
    await assert.rejects(stat(join(launch, 'authorized')), { code: 'ENOENT' });
    const login = await cli(['auth', 'login', server.endpoint], { cwd: home, approve });
    assert.equal(login.code, 0, login.output);
    assert.ok(!login.output.includes(server.token));
    const store = join(home, '.issue-runner-t3');
    const [file] = await readdir(store);
    const saved = JSON.parse(await readFile(join(store, file), 'utf8'));
    assert.equal(saved.accessToken, server.token);
    assert.equal(saved.scope, server.state.scope);
    assert.ok(saved.expiresAt > Date.now());
    if (process.platform !== 'win32') {
      assert.equal((await stat(store)).mode & 0o777, 0o700);
      assert.equal((await stat(join(store, file))).mode & 0o777, 0o600);
    } else {
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
        $ErrorActionPreference = 'Stop'
        $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
        foreach ($path in @($env:TEST_CREDENTIAL_DIR, $env:TEST_CREDENTIAL_FILE)) {
          $acl = Get-Acl -LiteralPath $path
          if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'Credential owner is not the current user' }
          $rules = $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
          if ($rules.Count -eq 0 -or @($rules | Where-Object { $_.IdentityReference -ne $sid }).Count -ne 0) { throw 'Credential ACL is not user-only' }
        }
      `], { env: { ...process.env, TEST_CREDENTIAL_DIR: store, TEST_CREDENTIAL_FILE: join(store, file) } });
    }
    const before = await stat(join(store, file));
    const status = await cli(['auth', 'status', server.endpoint]);
    assert.equal(status.code, 0, status.output);
    assert.ok(status.output.includes(`Authorized for ${server.endpoint}`));
    assert.equal((await stat(join(store, file))).mtimeMs, before.mtimeMs);
    const init = await cli(initArgs);
    assert.equal(init.code, 0, init.output);
    assert.ok(!init.output.includes(server.token));
    const template = await readFile(join(root, 'install', 'node_modules', 'issue-runner-core', 'templates', 'config.yaml'), 'utf8');
    const expected = parse(template);
    expected.terminalPlugins.mcpUrl = server.endpoint;
    const config = await readFile(join(launch, 'authorized', 'config.yaml'), 'utf8');
    assert.deepEqual(parse(config), expected);
    assert.deepEqual((await readdir(join(launch, 'authorized', 'prompts'))).sort(), ['documentation.md', 'implement.md', 'review.md']);
    const repeat = await cli(initArgs);
    assert.notEqual(repeat.code, 0);
    assert.match(repeat.output, /already exists/);
    assert.equal(await readFile(join(launch, 'authorized', 'config.yaml'), 'utf8'), config);
    assert.ok(server.state.reads >= 2);
  } finally { await server.close(); }
});

test('missing credentials prevent Core from creating a Project', async () => {
  const result = await cli(['init', '--project', 'unauthorized']);
  assert.notEqual(result.code, 0, result.output);
  assert.match(result.output, /auth login http:\/\/127\.0\.0\.1:3773\/mcp/);
  await assert.rejects(stat(join(launch, 'unauthorized')), { code: 'ENOENT' });
  const status = await cli(['auth', 'status']);
  assert.notEqual(status.code, 0);
  assert.match(status.output, /missing/i);
  assert.ok(status.output.includes('http://127.0.0.1:3773/mcp'));
  assert.deepEqual(await readdir(home), []);
});

test('normalized endpoints share credentials and distinct endpoints are isolated', async () => {
  const a = await substitute();
  const b = await substitute();
  try {
    assert.equal((await cli(['auth', 'login', `${a.endpoint}/`], { approve })).code, 0);
    assert.equal((await cli(['auth', 'status', a.endpoint])).code, 0);
    const other = await cli(['auth', 'status', b.endpoint]);
    assert.notEqual(other.code, 0);
    assert.match(other.output, /missing/i);
    assert.equal(b.state.reads, 0);
    assert.equal((await cli(['auth', 'login', b.endpoint], { approve })).code, 0);
    assert.equal((await cli(['auth', 'status', a.endpoint])).code, 0);
    assert.equal((await cli(['auth', 'status', b.endpoint])).code, 0);
    assert.equal((await readdir(join(home, '.issue-runner-t3'))).length, 2);
  } finally { await a.close(); await b.close(); }
});

test('status refuses non-private credential directories and files without repairing permissions', async () => {
  const server = await substitute();
  try {
    assert.equal((await cli(['auth', 'login', server.endpoint], { approve })).code, 0);
    const store = join(home, '.issue-runner-t3');
    const [file] = await readdir(store);
    const status = () => cli(['auth', 'status', server.endpoint]);
    for (const [path, widerMode] of [[store, 0o755], [join(store, file), 0o644]]) {
      if (process.platform === 'win32') {
        const ps = (script, env = {}) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference = 'Stop'; ${script}`], {
          env: { ...process.env, TEST_CREDENTIAL_PATH: path, ...env }, encoding: 'utf8',
        }).trim();
        const acl = () => ps('(Get-Acl -LiteralPath $env:TEST_CREDENTIAL_PATH).Sddl');
        const original = acl();
        ps(`$acl = Get-Acl -LiteralPath $env:TEST_CREDENTIAL_PATH
            $everyone = [System.Security.Principal.SecurityIdentifier]::new('S-1-1-0')
            $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($everyone, 'Read', 'Allow'))
            Set-Acl -LiteralPath $env:TEST_CREDENTIAL_PATH -AclObject $acl`);
        const widened = acl();
        assert.notEqual(widened, original);
        const result = await status();
        assert.notEqual(result.code, 0);
        assert.match(result.output, /Cannot read private credentials/i);
        assert.equal(acl(), widened);
        ps(`$acl = Get-Acl -LiteralPath $env:TEST_CREDENTIAL_PATH
            $everyone = [System.Security.Principal.SecurityIdentifier]::new('S-1-1-0')
            $acl.RemoveAccessRuleSpecific([System.Security.AccessControl.FileSystemAccessRule]::new($everyone, 'Read', 'Allow'))
            Set-Acl -LiteralPath $env:TEST_CREDENTIAL_PATH -AclObject $acl`);
      } else {
        const original = (await stat(path)).mode & 0o777;
        await chmod(path, widerMode);
        const result = await status();
        assert.notEqual(result.code, 0);
        assert.match(result.output, /Cannot read private credentials/i);
        assert.equal((await stat(path)).mode & 0o777, widerMode);
        await chmod(path, original);
      }
    }
    assert.equal(server.state.reads, 0);
    assert.equal((await status()).code, 0);
  } finally { await server.close(); }
});

test('status and the command gate report rejected, insufficient, expired, and unreachable access without leaking tokens', async () => {
  const server = await substitute();
  try {
    const project = join(launch, 'custom');
    await mkdir(project);
    await writeFile(join(project, 'config.yaml'), `terminalPlugins:\n  agentStartDelay: 0\n  mcpUrl: ${server.endpoint}/\n`);
    const run = () => cli(['run', '--project=custom', '--issue', '1']);
    const missing = await run();
    assert.notEqual(missing.code, 0);
    assert.ok(missing.output.includes(`auth login ${server.endpoint}`), missing.output);
    assert.equal((await cli(['auth', 'login', server.endpoint], { approve })).code, 0);
    const status = () => cli(['auth', 'status', server.endpoint]);
    server.state.reject = true;
    for (const result of [await status(), await run()]) {
      assert.notEqual(result.code, 0);
      assert.match(result.output, /rejected.*HTTP 401.*Sign in again/i);
      assert.ok(!result.output.includes(server.token));
    }
    server.state.reject = false;
    server.state.readError = true;
    const failedRead = await status();
    assert.notEqual(failedRead.code, 0);
    assert.match(failedRead.output, /authenticated MCP read/);
    assert.ok(!failedRead.output.includes(server.token));
    server.state.readError = false;
    const reads = server.state.reads;
    // Core can now validate the intentionally incomplete config, rather than failing authorization.
    const authorizedRun = await run();
    assert.notEqual(authorizedRun.code, 0);
    assert.match(authorizedRun.output, /tracker must be an object/i);
    assert.equal(server.state.reads, reads + 1);
    const store = join(home, '.issue-runner-t3');
    const [filename] = await readdir(store);
    const credentialFile = join(store, filename);
    const saved = await readFile(credentialFile, 'utf8');
    server.state.scope = 'orchestration:read';
    assert.notEqual((await cli(['auth', 'login', server.endpoint], { approve })).code, 0);
    assert.equal(await readFile(credentialFile, 'utf8'), saved);
    assert.equal((await status()).code, 0);
    await writeFile(credentialFile, JSON.stringify({ ...JSON.parse(saved), scope: 'orchestration:read' }));
    const insufficient = await status();
    assert.notEqual(insufficient.code, 0);
    assert.match(insufficient.output, /insufficient.*orchestration:operate/i);
    await writeFile(credentialFile, saved);
    server.state.scope = 'orchestration:read orchestration:operate';
    server.state.expires = 0;
    assert.notEqual((await cli(['auth', 'login', server.endpoint], { approve })).code, 0);
    assert.equal(await readFile(credentialFile, 'utf8'), saved);
    assert.equal((await status()).code, 0);
    await writeFile(credentialFile, JSON.stringify({ ...JSON.parse(saved), expiresAt: Date.now() - 1000 }));
    const expired = await run();
    assert.notEqual(expired.code, 0);
    assert.match(expired.output, /expired/i);
    assert.ok(expired.output.includes(`auth login ${server.endpoint}`));
    server.state.expires = 3600;
    assert.equal((await cli(['auth', 'login', server.endpoint], { approve })).code, 0);
  } finally { await server.close(); }
  const offline = await cli(['auth', 'status', server.endpoint]);
  assert.notEqual(offline.code, 0);
  assert.match(offline.output, /reachable/i);
  assert.ok(!offline.output.includes(server.token));
});

test('the browser callback rejects an incorrect state and does not save a denied grant', async () => {
  const server = await substitute();
  try {
    const deny = await cli(['auth', 'login', server.endpoint], {
      approve: async url => {
        const response = await fetch(url, { redirect: 'manual' });
        assert.equal(response.status, 302);
        const callback = new URL(response.headers.get('location'));
        const invalid = new URL(callback);
        invalid.searchParams.set('state', 'wrong');
        assert.equal((await fetch(invalid)).status, 400);
        callback.searchParams.delete('code');
        callback.searchParams.set('error', 'access_denied');
        assert.equal((await fetch(callback)).status, 200);
      },
    });
    assert.notEqual(deny.code, 0);
    assert.match(deny.output, /denied/i);
    assert.deepEqual(await readdir(home), []);
  } finally { await server.close(); }
});

test('a stalled MCP initialization notification times out before status or init can hang', async () => {
  const server = await substitute();
  try {
    assert.equal((await cli(['auth', 'login', server.endpoint], { approve })).code, 0);
    server.state.stallInitialized = true;
    const started = Date.now();
    const timeout = 20_000;
    const results = await Promise.all([
      cli(['auth', 'status', server.endpoint], { timeout }),
      cli(['init', '--project', 'stalled', '--mcp-url', server.endpoint], { timeout }),
    ]);
    assert.equal(server.state.stalled, 2);
    assert.ok(Date.now() - started < timeout);
    for (const result of results) {
      assert.equal(result.code, 1, result.output);
      assert.match(result.output, /timed out.*reachable/i);
      assert.ok(!result.output.includes(server.token));
    }
    await assert.rejects(stat(join(launch, 'stalled')), { code: 'ENOENT' });
  } finally { await server.close(); }
});
