import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { openSync, closeSync, readFileSync } from "node:fs";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
  rm,
  copyFile,
  rename,
  symlink,
} from "node:fs/promises";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, before, beforeEach, test } from "node:test";
import { parse, stringify } from "yaml";

let root, home, launch, bin, packageRoot;
function windowsPowerShellEnv(overrides) {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => key.toLowerCase() !== "psmodulepath",
      ),
    ),
    ...overrides,
  };
}

before(async () => {
  // Keep Node self-reference resolution out of the disposable global prefix.
  root = await mkdtemp(join(tmpdir(), "issue-runner-t3-test-"));
  // npm 11 exports global allow-scripts settings to lifecycle children, but scoped installs reject that flag.
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (key.toLowerCase() === "npm_config_allow_scripts") delete env[key];
  const options = { env, encoding: "utf8" };
  const npm = (args) =>
    process.env.npm_execpath
      ? execFileSync(
          process.execPath,
          [process.env.npm_execpath, ...args],
          options,
        )
      : execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", args, {
          ...options,
          shell: process.platform === "win32",
        });
  const [pack] = JSON.parse(
    npm(["pack", "--ignore-scripts", "--json", "--pack-destination", root]),
  );
  assert.equal(pack.filename, `issue-runner-agent-t3-${pack.version}.tgz`);
  npm([
    "install",
    "--global",
    // npm ci can cache tarballs without caching dependency metadata.
    "--prefer-offline",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--prefix",
    join(root, "install"),
    join(root, pack.filename),
  ]);
  packageRoot = join(
    root,
    "install",
    ...(process.platform === "win32" ? [] : ["lib"]),
    "node_modules",
    "issue-runner-agent-t3",
  );
  bin =
    process.platform === "win32"
      ? join(packageRoot, "dist", "cli.js")
      : join(root, "install", "bin", "issue-runner-t3");
  if (process.platform === "win32")
    await stat(join(root, "install", "issue-runner-t3.cmd"));
});
beforeEach(async () => {
  home = await mkdtemp(join(root, "home-"));
  launch = await mkdtemp(join(root, "launch-"));
});
after(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

function cli(args, options = {}) {
  return new Promise((resolve, reject) => {
    const entry = options.entry ?? bin;
    const viaNode = options.entry || process.platform === "win32";
    const stdout = options.log ? openSync(options.log, "w") : "pipe";
    const child = spawn(
      viaNode ? process.execPath : entry,
      viaNode ? [entry, ...args] : args,
      {
        cwd: options.cwd ?? launch,
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          BROWSER: process.execPath,
          T3CODE_THREAD_ID: "",
          ...options.env,
        },
        stdio: [options.control ? "pipe" : "ignore", stdout, "pipe"],
        timeout: options.timeout ?? 30_000,
      },
    );
    if (typeof stdout === "number") closeSync(stdout);
    let output = "";
    let approved = false;
    child.stdout?.on("data", (chunk) => {
      output += chunk;
      const url = output.match(/Approve access: (https?:\/\/[^\s]+)\n/)?.[1];
      if (url && options.approve && !approved) {
        approved = true;
        options.approve(url).catch((error) => {
          child.kill();
          reject(error);
        });
      }
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.once("error", reject);
    options.control?.(child);
    child.once("close", (code) => {
      try {
        resolve({
          code,
          output:
            (options.log ? readFileSync(options.log, "utf8") : "") + output,
        });
      } catch (error) {
        reject(error);
      }
    });
  });
}

test("installed CLI offers help and version without credentials", async () => {
  const help = await cli(["--help"]);
  assert.equal(help.code, 0, help.output);
  assert.match(help.output, /auth login/);
  assert.match(help.output, /init --project/);
  const authHelp = await cli(["auth", "--help"]);
  assert.equal(authHelp.code, 0);
  assert.match(
    authHelp.output,
    /Default MCP URL: http:\/\/127\.0\.0\.1:3773\/mcp/,
  );
  const version = await cli(["--version"]);
  assert.equal(version.code, 0, version.output);
  const manifest = JSON.parse(
    await readFile(join(packageRoot, "package.json"), "utf8"),
  );
  assert.equal(manifest.name, "issue-runner-agent-t3");
  assert.deepEqual(manifest.bin, { "issue-runner-t3": "dist/cli.js" });
  assert.equal(
    version.output.trim(),
    `issue-runner-t3 ${manifest.version} (core ${manifest.dependencies["issue-runner-core"]})`,
  );
});

test("installed credential storage can save and read a private credential", () => {
  const credentials = pathToFileURL(
    join(packageRoot, "dist", "credentials.js"),
  ).href;
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import assert from "node:assert/strict";
    import { saveCredential, requireCredential } from ${JSON.stringify(credentials)};
    const endpoint = "http://127.0.0.1:3773/mcp";
    const credential = { accessToken: "fixture-token", expiresAt: Date.now() + 60_000, scope: "orchestration:operate" };
    await saveCredential(endpoint, credential);
    assert.deepEqual(await requireCredential(endpoint), credential);
  `,
    ],
    {
      env: { ...process.env, HOME: home, USERPROFILE: home },
      encoding: "utf8",
    },
  );
});

test("installed Runner includes its discoverable companion skill", async () => {
  const source = await readFile(
    join(packageRoot, "skills", "issue-runner-t3", "SKILL.md"),
    "utf8",
  );
  const [, metadata] = source.split("---");
  assert.equal(parse(metadata).name, "issue-runner-t3");
  assert.ok(
    (
      await stat(
        join(
          packageRoot,
          "skills",
          "issue-runner-t3",
          "scripts",
          "launch-terminal.mjs",
        ),
      )
    ).isFile(),
  );
});

test("run refuses missing or blank launcher thread before authorization", async () => {
  for (const id of [undefined, "", "   "]) {
    const result = await cli(["run", "--project", "demo", "--issue", "42"], {
      env: { T3CODE_THREAD_ID: id },
    });
    assert.notEqual(result.code, 0);
    assert.match(
      result.output,
      /Start issue-runner-t3 from a T3 Code integrated terminal\./,
    );
    assert.doesNotMatch(result.output, /Missing credentials/);
  }
});

const unauthorized = Symbol("unauthorized");
function replyToTool(res, rpc, payload, finishedToolResponses, json) {
  if (payload === unauthorized) return json({ error: "invalid_token" }, 401);
  if (payload === undefined) return res.destroy();
  res.once("finish", () =>
    finishedToolResponses.push({ name: rpc.params.name, payload }),
  );
  return json({
    jsonrpc: "2.0",
    id: rpc.id,
    result: { content: [{ type: "text", text: JSON.stringify(payload) }] },
  });
}

async function substitute(
  taskTool = (name) => assert.fail(`Unexpected T3 tool ${name}`),
) {
  const token = `disposable-${randomUUID()}`;
  const state = {
    scope: "orchestration:read orchestration:operate",
    expires: 3600,
    reject: false,
    reads: 0,
    readError: false,
    stallInitialized: false,
    stalled: 0,
    finishedToolResponses: [],
    authorizations: new Set([`Bearer ${token}`]),
  };
  let registration, authorization;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, endpoint);
    let body = "";
    for await (const chunk of req) body += chunk;
    const json = (data, code = 200) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    };
    try {
      if (url.pathname === "/oauth/mcp/register") {
        registration = JSON.parse(body);
        assert.equal(registration.client_name, "issue-runner-t3");
        return json({ client_id: "test-client" }, 201);
      }
      if (url.pathname === "/oauth/mcp/authorize") {
        authorization = url.searchParams;
        assert.equal(authorization.get("client_id"), "test-client");
        assert.equal(authorization.get("code_challenge_method"), "S256");
        assert.match(authorization.get("scope"), /orchestration:operate/);
        assert.equal(authorization.get("resource"), endpoint);
        assert.equal(
          authorization.get("redirect_uri"),
          registration.redirect_uris[0],
        );
        const redirect = new URL(authorization.get("redirect_uri"));
        assert.equal(redirect.hostname, "127.0.0.1");
        redirect.searchParams.set("code", "test-code");
        redirect.searchParams.set("state", authorization.get("state"));
        redirect.searchParams.set("iss", url.origin);
        res.writeHead(302, { Location: redirect.href });
        return res.end();
      }
      if (url.pathname === "/oauth/mcp/token") {
        const params = new URLSearchParams(body);
        assert.equal(params.get("code"), "test-code");
        assert.equal(params.get("grant_type"), "authorization_code");
        assert.equal(params.get("client_id"), "test-client");
        assert.equal(params.get("redirect_uri"), registration.redirect_uris[0]);
        assert.equal(params.get("resource"), endpoint);
        assert.equal(
          createHash("sha256")
            .update(params.get("code_verifier"))
            .digest("base64url"),
          authorization.get("code_challenge"),
        );
        const accessToken = state.replacementToken ?? token;
        state.authorizations.add(`Bearer ${accessToken}`);
        return json({
          access_token: accessToken,
          expires_in: state.expires,
          token_type: "Bearer",
          scope: state.scope,
        });
      }
      assert.equal(url.pathname, "/mcp");
      if (
        state.reject ||
        !state.authorizations.has(req.headers.authorization)
      ) {
        return json({ error: "invalid_token", detail: token }, 401);
      }
      if (req.method === "GET" || req.method === "DELETE") {
        res.writeHead(405);
        return res.end();
      }
      const rpc = JSON.parse(body);
      if (rpc.method === "initialize") {
        return json({
          jsonrpc: "2.0",
          id: rpc.id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "T3 substitute", version: "0.1.11" },
          },
        });
      }
      if (rpc.method === "notifications/initialized") {
        if (state.stallInitialized) {
          state.stalled++;
          return;
        }
        res.writeHead(202);
        return res.end();
      }
      assert.equal(rpc.method, "tools/call");
      if (rpc.params.name !== "t3_project_list") {
        if (rpc.params.name === "t3_thread_send")
          assert.equal(rpc.params.arguments.mode, "queue");
        const payload = await taskTool(
          rpc.params.name,
          rpc.params.arguments,
          req.headers.authorization,
        );
        return replyToTool(
          res,
          rpc,
          payload,
          state.finishedToolResponses,
          json,
        );
      }
      state.reads++;
      if (state.readError)
        return json({
          jsonrpc: "2.0",
          id: rpc.id,
          result: {
            content: [{ type: "text", text: JSON.stringify({ error: token }) }],
          },
        });
      return json({
        jsonrpc: "2.0",
        id: rpc.id,
        result: {
          content: [
            { type: "text", text: '{"projects":[],"nextCursor":null}' },
          ],
        },
      });
    } catch (error) {
      json({ error: error.message }, 500);
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const endpoint = `http://127.0.0.1:${server.address().port}/mcp`;
  return {
    endpoint,
    token,
    state,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const approve = async (url) => {
  const response = await fetch(url);
  assert.equal(response.status, 200);
};

test("packed Enhancement binds fresh and resumed Tabs independently", async () => {
  const sent = new Map();
  const reads = [];
  const server = await substitute((name, args) => {
    if (name === "t3_thread_read") {
      reads.push(args.threadId);
      return {
        thread: {
          threadId: args.threadId,
          projectId: "project",
          worktreePath: launch,
          activeRunId: null,
          status: "completed",
          archived: false,
          title: "resumed",
        },
      };
    }
    if (name === "t3_queue") return { items: [], nextCursor: null };
    if (name === "t3_thread_launch")
      return { threadId: "fresh-thread", projectId: "project", runId: null };
    if (name === "t3_thread_send") {
      sent.set(args.threadId, args.message);
      return {
        threadId: args.threadId,
        runId: randomUUID(),
        messageId: randomUUID(),
      };
    }
    assert.fail(`Unexpected T3 tool ${name}`);
  });
  try {
    assert.equal(
      (await cli(["auth", "login", server.endpoint], { approve })).code,
      0,
    );
    const entry = join(
      root,
      "install",
      ...(process.platform === "win32" ? [] : ["lib"]),
      "enhancement-check.mjs",
    );
    await copyFile(
      new URL("./fixtures/enhancement-check.mjs", import.meta.url),
      entry,
    );
    const result = await cli([server.endpoint], { entry });
    assert.equal(result.code, 0, result.output);
    assert.deepEqual(reads, ["launcher", "saved-thread", "saved-thread"]);
    assert.deepEqual(
      sent,
      new Map([
        ["fresh-thread", "Assignment"],
        ["saved-thread", "continue"],
      ]),
    );
  } finally {
    await server.close();
  }
});

test("adapter acknowledges delivery without a handoff and rejects malformed archival status", async () => {
  const history = [];
  let archiveRequests = 0;
  const handoff = join(launch, "handoff.json");
  const server = await substitute((name, args) => {
    if (name === "t3_thread_read")
      return {
        thread: {
          threadId: args.threadId,
          projectId: "project",
          activeRunId: null,
          archived: false,
          status: ["completed"],
        },
      };
    if (name === "t3_thread_launch")
      return { threadId: "task", projectId: "project", runId: null };
    if (name === "t3_thread_send") {
      history.push(args.message);
      assert.equal(args.threadId, "task");
      return {
        threadId: "task",
        messageId: "message",
        runId: "run",
        status: "running",
        delivery: "started",
      };
    }
    if (name === "t3_thread_organize") {
      archiveRequests++;
      return { sequence: 1 };
    }
    assert.fail(`Unexpected T3 tool ${name}`);
  });
  try {
    assert.equal(
      (await cli(["auth", "login", server.endpoint], { approve })).code,
      0,
    );
    const result = await cli([server.endpoint, handoff], {
      entry: fileURLToPath(
        new URL("./fixtures/adapter-check.mjs", import.meta.url),
      ),
      timeout: 15_000,
    });
    assert.equal(result.code, 0, result.output);
    assert.deepEqual(history, [`Handoff path: ${handoff}`]);
    assert.equal(archiveRequests, 0);
    await assert.rejects(stat(handoff), { code: "ENOENT" });
  } finally {
    await server.close();
  }
});

test("closure retains ownership across busy work and archive failure, and recognizes confirmed disappearance", async () => {
  const idle = {
    threadId: "task",
    projectId: "project",
    activeRunId: null,
    archived: false,
    status: "completed",
  };
  const observations = [
    ["t3_thread_read", { thread: { ...idle, activeRunId: "running" } }],
    ["t3_thread_read", { thread: idle }],
    ["t3_queue", { items: [{ queuedRunId: "held" }], nextCursor: null }],
    ["t3_thread_read", { thread: idle }],
    ["t3_queue", { items: [], nextCursor: null }],
    ["t3_thread_read", { thread: { ...idle, status: "running" } }],
    ["t3_thread_read", { thread: idle }],
    ["t3_queue", { items: [], nextCursor: null }],
    ["t3_thread_read", { thread: idle }],
    [
      "t3_thread_organize",
      { code: "invalid_request", message: "Archive refused" },
    ],
    [
      "t3_thread_read",
      { code: "thread_not_found", message: "Thread not found" },
    ],
  ];
  const server = await substitute((name, args) => {
    if (name === "t3_thread_read" && args.threadId === "launcher")
      return { thread: { threadId: "launcher", projectId: "project" } };
    if (name === "t3_thread_launch")
      return { threadId: "task", projectId: "project", runId: null };
    assert.equal(args.threadId, "task");
    const [expected, response] = observations.shift();
    assert.equal(name, expected);
    if (name === "t3_queue")
      assert.deepEqual(args, { threadId: "task", action: "list", limit: 1 });
    if (name === "t3_thread_organize")
      assert.deepEqual(args, { threadId: "task", action: "archive" });
    return response;
  });
  try {
    assert.equal(
      (await cli(["auth", "login", server.endpoint], { approve })).code,
      0,
    );
    const result = await cli(
      [server.endpoint, "busy", "busy", "busy", "Archive refused"],
      {
        entry: fileURLToPath(
          new URL("./fixtures/close-check.mjs", import.meta.url),
        ),
      },
    );
    assert.equal(result.code, 0, result.output);
    assert.deepEqual(observations, []);
  } finally {
    await server.close();
  }
});

test("exact resume validates the saved thread before unarchive, rename or input", async () => {
  const original = {
    threadId: "saved-thread",
    projectId: "project",
    worktreePath: launch,
    title: "issue-42 implement",
    archived: true,
    activeRunId: null,
    status: "completed",
    model: "original-model",
  };
  const history = ["Implementation context"];
  let thread,
    calls,
    afterQueueRead,
    queued = false,
    renameDenied = false;
  const server = await substitute((name, args) => {
    if (name === "t3_thread_read" && args.threadId === "launcher")
      return { thread: { threadId: "launcher", projectId: "project" } };
    calls.push(name);
    assert.equal(args.threadId, "saved-thread");
    if (name === "t3_thread_read")
      return thread
        ? { thread, recentRuns: [], items: history }
        : { code: "thread_not_found", message: "Thread not found" };
    if (name === "t3_queue") {
      assert.deepEqual(args, {
        threadId: "saved-thread",
        action: "list",
        limit: 1,
      });
      if (afterQueueRead !== undefined) {
        queued = false;
        thread = afterQueueRead && { ...thread, ...afterQueueRead };
      }
      return {
        items: queued
          ? [
              {
                queuedRunId: "older-queued-run",
                text: "Pending",
                truncated: false,
              },
            ]
          : [],
        nextCursor: null,
      };
    }
    if (name === "t3_thread_organize") {
      assert.deepEqual(args, { threadId: "saved-thread", action: "unarchive" });
      thread.archived = false;
      return { sequence: 1 };
    }
    if (name === "t3_thread_update") {
      assert.equal(thread.archived, false);
      assert.equal(args.action, "rename");
      assert.equal(args.title, "issue-42 fix review r1");
      assert.ok(!("modelSelection" in args));
      if (renameDenied)
        return { code: "invalid_request", message: "Rename rejected" };
      thread.title = args.title;
      return { sequence: 2, title: thread.title };
    }
    if (name === "t3_thread_send") {
      assert.equal(thread.title, "issue-42 fix review r1");
      assert.equal(thread.archived, false);
      assert.equal(thread.model, "original-model");
      history.push(args.message);
      return { threadId: args.threadId, messageId: "message", runId: "run" };
    }
    assert.fail(`Unexpected T3 tool ${name}`);
  });
  try {
    assert.equal(
      (await cli(["auth", "login", server.endpoint], { approve })).code,
      0,
    );
    const resume = (error) =>
      cli([server.endpoint, ...(error ? [error] : [])], {
        entry: fileURLToPath(
          new URL("./fixtures/resume-check.mjs", import.meta.url),
        ),
      });
    for (const [override, error] of [
      [null, "not found"],
      [{ threadId: "different" }, "identity"],
      [{ projectId: "different" }, "project"],
      [{ worktreePath: null }, "worktree"],
      [{ worktreePath: "." }, "worktree"],
      [{ worktreePath: home }, "worktree"],
      [{ activeRunId: "active" }, "finish or stop"],
      [{ status: "queued" }, "finish or stop"],
    ]) {
      thread = override && { ...original, ...override };
      calls = [];
      const result = await resume(error);
      assert.equal(result.code, 0, result.output);
      assert.deepEqual(calls, ["t3_thread_read"]);
      assert.deepEqual(history, ["Implementation context"]);
    }
    thread = { ...original };
    queued = true;
    calls = [];
    const held = await resume("finish or stop");
    assert.equal(held.code, 0, held.output);
    assert.deepEqual(calls, ["t3_thread_read", "t3_queue"]);
    assert.deepEqual(history, ["Implementation context"]);
    for (const [change, error] of [
      [
        { activeRunId: "older-queued-run", status: "running" },
        "finish or stop",
      ],
      [null, "not found"],
      [{ threadId: "different" }, "identity"],
      [{ projectId: "different" }, "project"],
      [{ worktreePath: home }, "worktree"],
    ]) {
      thread = { ...original, archived: false };
      queued = change?.status === "running";
      afterQueueRead = change;
      calls = [];
      const changed = await resume(error);
      assert.equal(changed.code, 0, changed.output);
      assert.deepEqual(calls, ["t3_thread_read", "t3_queue", "t3_thread_read"]);
      assert.deepEqual(history, ["Implementation context"]);
    }
    afterQueueRead = undefined;
    queued = false;
    thread = { ...original };
    renameDenied = true;
    calls = [];
    const rejected = await resume("rename rejected");
    assert.equal(rejected.code, 0, rejected.output);
    assert.deepEqual(calls, [
      "t3_thread_read",
      "t3_queue",
      "t3_thread_read",
      "t3_thread_organize",
      "t3_thread_update",
    ]);
    assert.deepEqual(history, ["Implementation context"]);
    renameDenied = false;
    const alias = join(home, "worktree-alias");
    await symlink(
      launch,
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    thread = { ...original, worktreePath: alias };
    calls = [];
    const result = await resume();
    assert.equal(result.code, 0, result.output);
    assert.deepEqual(calls, [
      "t3_thread_read",
      "t3_queue",
      "t3_thread_read",
      "t3_thread_organize",
      "t3_thread_update",
      "t3_thread_send",
    ]);
    assert.deepEqual(history, ["Implementation context", "Review fix"]);
    calls = [];
    const unchanged = await resume();
    assert.equal(unchanged.code, 0, unchanged.output);
    assert.deepEqual(calls, [
      "t3_thread_read",
      "t3_queue",
      "t3_thread_read",
      "t3_thread_send",
    ]);
  } finally {
    await server.close();
  }
});

async function gitFixture() {
  const origin = join(launch, "origin");
  const checkout = join(launch, "checkout");
  const git = (cwd, ...args) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      env: { ...process.env, HOME: home, USERPROFILE: home },
    }).trim();
  await mkdir(checkout);
  git(checkout, "init", "-b", "main");
  git(checkout, "config", "user.name", "Fixture");
  git(checkout, "config", "user.email", "fixture@example.invalid");
  git(checkout, "config", "commit.gpgsign", "false");
  git(checkout, "commit", "--allow-empty", "-m", "Initial commit");
  git(launch, "clone", "--bare", checkout, origin);
  git(checkout, "remote", "add", "origin", origin);
  const worktree = () =>
    git(checkout, "worktree", "list", "--porcelain", "-z")
      .split("\0")
      .filter((field) => field.startsWith("worktree "))[1]
      ?.slice("worktree ".length);
  const commit = async (worktree, message) => {
    await writeFile(join(worktree, "fixture.txt"), message);
    git(worktree, "add", "fixture.txt");
    git(worktree, "commit", "-m", message);
    return { sha: git(worktree, "rev-parse", "HEAD"), message };
  };
  return { checkout, worktree, commit };
}

async function coreFixture() {
  const { checkout, worktree, commit } = await gitFixture();
  const project = join(launch, "demo");
  const commands = join(launch, "commands");
  const stateFile = join(launch, "fixture.json");
  const log = join(launch, "run.log");
  await mkdir(commands);
  await writeFile(stateFile, "{}");
  const dest = join(commands, "gh");
  await copyFile(new URL("./fixtures/core-command.mjs", import.meta.url), dest);
  await chmod(dest, 0o755);
  const fixture = async () => ({
    ...JSON.parse(await readFile(stateFile, "utf8")),
    worktree: worktree(),
  });
  const checkpoint = async () => {
    const dir = join(project, "recovery");
    const file = (await readdir(dir)).find((name) => name.endsWith("-42.json"));
    return JSON.parse(await readFile(join(dir, file), "utf8"));
  };
  async function initialize(endpoint, review, marker) {
    assert.equal((await cli(["auth", "login", endpoint], { approve })).code, 0);
    assert.equal(
      (await cli(["init", "--project", "demo", "--mcp-url", endpoint])).code,
      0,
    );
    const configPath = join(project, "config.yaml");
    const config = parse(await readFile(configPath, "utf8"));
    const agent = {
      agent: "t3",
      start:
        "t3 start --provider codex-instance --model fixture-model --option reasoningEffort=high",
      resume: "t3 resume {sessionref}",
    };
    Object.assign(config, {
      repository: "fixture/repo",
      checkout,
      issueLabel: "",
      operationRetry: 0,
      workflow: { review, maxReviewRounds: 2 },
      tracker: { reservationLabel: "fixture:reserved" },
      agents: {
        implement: agent,
        review: agent,
        ciRepair: agent,
        conflictRepair: agent,
      },
    });
    // A fallback to Core's base startup delay must not pass these tests.
    config.terminalPlugins.agentStartDelay = 60;
    config.terminalPlugins.enhancements = { retryLimit: 0 };
    await writeFile(configPath, stringify(config));
    await writeFile(join(project, "prompts", "implement.md"), marker);
    await writeFile(
      join(project, "prompts", "review.md"),
      "Review the fixture.",
    );
  }
  const runCli = (control, timeout) =>
    cli(["run", "--project", "demo", "--issue", "42"], {
      log,
      control,
      timeout,
      env: {
        T3CODE_THREAD_ID: "launcher-thread",
        PATH: `${commands}${delimiter}${process.env.PATH}`,
        FIXTURE_STATE: stateFile,
      },
    });
  return { log, fixture, checkpoint, initialize, runCli, commit };
}

const receipt = ["receipt"];
const lostReplies = ["drop", "malformed", "receipt"];
const exhausted = ["drop", "drop", "drop"];
const retryExhausted = /Retry budget exhausted after 3 attempts/;
const signInWarning = /signing in again changes the deduplication scope/;
const scenarios = [
  { name: "normal", launch: receipt, send: receipt, threads: 1, messages: 1 },
  {
    name: "reject launch",
    launch: ["reject"],
    send: [],
    threads: 0,
    messages: 0,
    errors: [/worktreePath must be one of the project's git worktrees/],
  },
  {
    name: "lost replies",
    launch: lostReplies,
    send: lostReplies,
    threads: 1,
    messages: 1,
    rotateCredential: true,
  },
  {
    name: "reject send",
    launch: receipt,
    send: ["reject"],
    threads: 1,
    messages: 0,
    errors: [/Thread cannot receive messages/],
  },
  {
    name: "exhaust launch",
    launch: exhausted,
    send: [],
    threads: 1,
    messages: 0,
    errors: [
      retryExhausted,
      signInWarning,
      /idle T3 task thread may already exist/,
    ],
  },
  {
    name: "exhaust send",
    launch: receipt,
    send: ["drop", "drop", "orchestration_error"],
    threads: 1,
    messages: 1,
    errors: [
      retryExhausted,
      signInWarning,
      /Accepted without a durable projection/,
      /prompt may already have reached T3 thread native-task-thread/,
    ],
  },
  {
    name: "reject invalid send identities",
    launch: receipt,
    send: ["wrong-thread", "blank-run", "blank-message"],
    threads: 1,
    messages: 1,
    errors: [retryExhausted, signInWarning],
  },
  {
    name: "thread missing after lost send reply",
    launch: receipt,
    send: ["drop", "not_found"],
    threads: 1,
    messages: 1,
    errors: [
      /Thread not found/,
      signInWarning,
      /prompt may already have reached T3 thread native-task-thread/,
    ],
  },
  {
    name: "orchestration error on launch",
    launch: ["orchestration_error", "receipt"],
    send: receipt,
    threads: 1,
    messages: 1,
  },
  {
    name: "orchestration error on send",
    launch: receipt,
    send: ["orchestration_error", "receipt"],
    threads: 1,
    messages: 1,
  },
];

for (const scenario of scenarios)
  test(
    `native task thread: ${scenario.name}`,
    { skip: process.platform === "win32" },
    async () => {
      const { log, fixture, checkpoint, initialize, runCli } =
        await coreFixture();
      const launcher = "launcher-thread";
      const id = "native-task-thread";
      const projectId = "launcher-project";
      const marker = "Entire user prompt.\n\nSecond line with Unicode: 雪.";
      const history = [];
      let launched,
        archived = false,
        pending,
        delivered,
        accepted,
        launcherReads;
      const attempts = { t3_thread_launch: [], t3_thread_send: [] };
      const replies = {
        t3_thread_launch: scenario.launch,
        t3_thread_send: scenario.send,
      };
      const receipts = new Map();
      const plannedReply = (reply, receipt) => {
        switch (reply) {
          case "drop":
            return undefined;
          case "malformed":
            return {};
          case "wrong-thread":
            return { ...receipt, threadId: "another-thread" };
          case "blank-run":
            return { ...receipt, runId: " " };
          case "blank-message":
            return { ...receipt, messageId: " " };
          case "not_found":
            return { code: "thread_not_found", message: "Thread not found" };
          case "orchestration_error":
            return {
              _tag: "OrchestratorMcpFailure",
              code: "orchestration_error",
              message: "Accepted without a durable projection.",
            };
          case "receipt":
            return receipt;
          default:
            assert.fail(`Unexpected reply ${reply}`);
        }
      };
      const assertRetryIdentity = () => {
        const ids = new Set();
        for (const calls of Object.values(attempts)) {
          if (!calls.length) continue;
          const first = calls[0];
          assert.match(first.args.clientRequestId, /^[0-9a-f-]{36}$/);
          assert.ok(
            !ids.has(first.args.clientRequestId),
            "Every logical operation needs a fresh request ID",
          );
          ids.add(first.args.clientRequestId);
          for (let i = 1; i < calls.length; i++) {
            assert.deepEqual(calls[i].args, first.args);
            assert.equal(calls[i].authorization, first.authorization);
            assert.ok(
              calls[i].time - calls[i - 1].time >= 5000,
              "Retry must wait five seconds",
            );
          }
        }
      };
      // Model a new sign-in replacing the saved credential while a logical operation is in flight.
      const replaceCredential = async () => {
        const store = join(home, ".issue-runner-t3");
        const [file] = await readdir(store);
        const path = join(store, file);
        const credential = JSON.parse(await readFile(path, "utf8"));
        const accessToken = `replacement-${randomUUID()}`;
        server.state.authorizations.add(`Bearer ${accessToken}`);
        await writeFile(path, JSON.stringify({ ...credential, accessToken }));
      };
      const server = await substitute(async (name, args, authorization) => {
        const requestKey = `${authorization}:${args.clientRequestId}`;
        let reply;
        if (name in attempts) {
          const calls = attempts[name];
          reply = replies[name][calls.length];
          calls.push({ args, authorization, time: performance.now() });
          assert.ok(reply, `Unexpected ${name} attempt ${calls.length}`);
          if (receipts.has(requestKey))
            return plannedReply(reply, receipts.get(requestKey));
        }
        const recordReceipt = async (receipt) => {
          receipts.set(requestKey, receipt);
          if (scenario.rotateCredential) await replaceCredential();
          return plannedReply(reply, receipt);
        };
        if (name === "t3_thread_read") {
          if (args.threadId === launcher) {
            launcherReads = server.state.reads;
            return { thread: { threadId: launcher, projectId } };
          }
          assert.equal(args.threadId, id);
          return {
            thread: {
              threadId: id,
              projectId,
              archived,
              activeRunId: null,
              status: "completed",
            },
            recentRuns: [],
            items: history,
          };
        }
        if (name === "t3_thread_launch") {
          assert.equal(launched, undefined);
          assert.ok(
            server.state.reads > launcherReads,
            "Tab creation must authorize after launcher resolution",
          );
          assert.equal(args.projectId, projectId);
          assert.equal(args.title, "issue-42 implement");
          assert.deepEqual(args.modelSelection, {
            instanceId: "codex-instance",
            model: "fixture-model",
            options: [{ id: "reasoningEffort", value: "high" }],
          });
          assert.deepEqual(args.workspaceStrategy, {
            type: "existing_worktree",
            worktreePath: (await fixture()).worktree,
          });
          assert.ok(!("message" in args));
          launched = args;
          if (reply === "reject")
            return {
              _tag: "OrchestratorMcpFailure",
              code: "invalid_request",
              message: `worktreePath must be one of the project's git worktrees. ${server.token}`,
            };
          return recordReceipt({
            threadId: id,
            projectId,
            modelSelection: args.modelSelection,
            runId: null,
            status: null,
          });
        }
        if (name === "t3_thread_send") {
          const liveOutput = readFileSync(log, "utf8");
          assert.equal(args.threadId, id);
          assert.equal(history.length, 0);
          const saved = await checkpoint();
          assert.equal(saved.roles.implement.sessionid, id);
          assert.equal(saved.phase, "implementing");
          assert.ok(
            liveOutput.includes(
              `Issue #42 implement sessionid=${id} handoff=${saved.invocation.path}`,
            ),
            liveOutput,
          );
          const template = await readFile(
            join(
              packageRoot,
              "node_modules",
              "issue-runner-core",
              "prompts",
              "implement.md",
            ),
            "utf8",
          );
          assert.equal(
            args.message,
            template
              .trimEnd()
              .replace("{{issue}}", "42")
              .replace("{{instructions}}", marker)
              .replace("{{path}}", JSON.stringify(saved.invocation.path)),
          );
          assert.equal(saved.probe, undefined);
          if (reply === "reject")
            return {
              _tag: "OrchestratorMcpFailure",
              code: "thread_not_sendable",
              message: "Thread cannot receive messages.",
            };
          history.push(args.message);
          delivered = saved.invocation.path;
          return recordReceipt({
            threadId: id,
            messageId: "message-1",
            runId: "run-1",
            status: "running",
            delivery: "started",
          });
        }
        if (name === "t3_queue") {
          assert.deepEqual(args, { threadId: id, action: "list", limit: 1 });
          return { items: [], nextCursor: null };
        }
        if (name === "t3_thread_organize") {
          assert.deepEqual(args, { threadId: id, action: "archive" });
          const saved = await checkpoint();
          assert.equal(saved.phase, "implementation_completed");
          assert.equal(saved.result.outcome, "no_change");
          accepted = saved;
          archived = true;
          return { sequence: 1 };
        }
        assert.fail(`Unexpected T3 tool ${name}`);
      });
      try {
        await initialize(server.endpoint, false, marker);
        const run = runCli(undefined, 60_000);
        if (!scenario.errors) {
          // Observe the pending checkpoint after the server finishes sending a valid receipt, before Agent completion.
          const deadline = Date.now() + 40_000;
          const validSendResponseFinished = () =>
            server.state.finishedToolResponses.some(
              ({ name, payload }) =>
                name === "t3_thread_send" &&
                payload.threadId === id &&
                payload.messageId === "message-1" &&
                payload.runId === "run-1",
            );
          while (!validSendResponseFinished() && Date.now() < deadline) {
            const early = await Promise.race([
              run,
              new Promise((resolve) => setTimeout(resolve, 100)),
            ]);
            assert.equal(early, undefined, early?.output);
          }
          assert.ok(
            delivered && validSendResponseFinished(),
            "No valid send receipt finished",
          );
          await assert.rejects(stat(delivered), { code: "ENOENT" });
          pending = await checkpoint();
          assert.equal(pending.phase, "implementing");
          assert.equal(pending.result, undefined);
          assert.equal(archived, false);
          assert.equal((await fixture()).closed, undefined);
          await writeFile(
            `${delivered}.tmp`,
            JSON.stringify({
              outcome: "no_change",
              summary: "Fixture already satisfied.",
              commits: [],
              findings_file: null,
              pr_title: "Fixture",
              pr_body: "Closes #42",
            }),
          );
          await rename(`${delivered}.tmp`, delivered);
        }
        const result = await run;
        assertRetryIdentity();
        assert.deepEqual(
          Object.values(attempts).map((calls) => calls.length),
          [scenario.launch.length, scenario.send.length],
        );
        assert.equal(history.length, scenario.messages);
        assert.equal(receipts.size, scenario.threads + scenario.messages);
        assert.ok(launched);
        assert.ok(!result.output.includes(server.token));
        if (scenario.errors) {
          assert.notEqual(result.code, 0, result.output);
          for (const error of scenario.errors)
            assert.match(result.output, error);
          assert.equal(
            retryExhausted.test(result.output),
            scenario.errors.includes(retryExhausted),
          );
          assert.equal(
            (await checkpoint()).roles.implement?.sessionid,
            scenario.send.length ? id : undefined,
          );
          assert.equal(archived, false);
          assert.equal((await fixture()).closed, undefined);
          return;
        }
        assert.equal(result.code, 0, result.output);
        assert.ok(
          result.output.includes(
            `Issue #42 implement sessionid=${id} handoff=${delivered}`,
          ),
          result.output,
        );
        if (scenario.rotateCredential) {
          assert.equal(
            attempts.t3_thread_launch[0].authorization,
            `Bearer ${server.token}`,
          );
          assert.equal(
            attempts.t3_thread_send[0].authorization,
            [...server.state.authorizations][1],
          );
        }
        assert.ok(archived && accepted);
        assert.equal((await fixture()).closed, true);
      } finally {
        await server.close();
      }
    },
  );

for (const mode of ["recover-handoff", "recover-enter"])
  test(
    `fresh CLI resumes interrupted implementation (${mode})`,
    { skip: process.platform === "win32" },
    async () => {
      const { log, fixture, checkpoint, initialize, runCli } =
        await coreFixture();
      const launcher = "launcher-thread";
      const id = "native-task-thread";
      const projectId = "launcher-project";
      const marker = "Entire user prompt.\n\nSecond line with Unicode: 雪.";
      const history = [];
      let launched,
        archived = false,
        pending,
        delivered,
        accepted,
        launcherReads,
        busy = false,
        taskReads = 0;
      const server = await substitute(async (name, args) => {
        if (name === "t3_thread_read") {
          if (args.threadId === launcher) {
            launcherReads = server.state.reads;
            return { thread: { threadId: launcher, projectId } };
          }
          assert.equal(args.threadId, id);
          taskReads++;
          return {
            thread: {
              threadId: id,
              projectId,
              worktreePath: launched.workspaceStrategy.worktreePath,
              title: launched.title,
              archived,
              activeRunId: busy ? "run-1" : null,
              status: busy ? "running" : "completed",
            },
            recentRuns: [],
            items: history,
          };
        }
        if (name === "t3_thread_launch") {
          assert.equal(launched, undefined);
          assert.ok(
            server.state.reads > launcherReads,
            "Tab creation must authorize after launcher resolution",
          );
          assert.equal(args.projectId, projectId);
          assert.equal(args.title, "issue-42 implement");
          assert.deepEqual(args.modelSelection, {
            instanceId: "codex-instance",
            model: "fixture-model",
            options: [{ id: "reasoningEffort", value: "high" }],
          });
          assert.deepEqual(args.workspaceStrategy, {
            type: "existing_worktree",
            worktreePath: (await fixture()).worktree,
          });
          assert.ok(!("message" in args));
          launched = args;
          return {
            threadId: id,
            projectId,
            modelSelection: args.modelSelection,
            runId: null,
            status: null,
          };
        }
        if (name === "t3_queue") {
          assert.deepEqual(args, { threadId: id, action: "list", limit: 1 });
          return { items: [], nextCursor: null };
        }
        if (name === "t3_thread_send") {
          const liveOutput = readFileSync(log, "utf8");
          assert.equal(args.threadId, id);
          const saved = await checkpoint();
          assert.equal(saved.roles.implement.sessionid, id);
          assert.equal(saved.phase, "implementing");
          assert.ok(
            liveOutput.includes(
              `Issue #42 implement sessionid=${id} handoff=${saved.invocation.path}`,
            ),
            liveOutput,
          );
          const template = await readFile(
            join(
              packageRoot,
              "node_modules",
              "issue-runner-core",
              "prompts",
              "implement.md",
            ),
            "utf8",
          );
          assert.equal(
            args.message,
            history.length
              ? "continue"
              : template
                  .trimEnd()
                  .replace("{{issue}}", "42")
                  .replace("{{instructions}}", marker)
                  .replace("{{path}}", JSON.stringify(saved.invocation.path)),
          );
          assert.equal(busy, false);
          assert.equal(saved.probe, undefined);
          history.push(args.message);
          delivered = saved.invocation.path;
          return {
            threadId: id,
            messageId: "message-1",
            runId: "run-1",
            status: "running",
            delivery: "started",
          };
        }
        if (name === "t3_thread_organize") {
          assert.deepEqual(args, { threadId: id, action: "archive" });
          const saved = await checkpoint();
          assert.equal(saved.phase, "implementation_completed");
          assert.equal(saved.result.outcome, "no_change");
          accepted = saved;
          archived = true;
          return { sequence: 1 };
        }
        assert.fail(`Unexpected T3 tool ${name}`);
      });
      let child;
      try {
        await initialize(server.endpoint, false, marker);
        let run = runCli((process) => {
          child = process;
        });
        // Observe the acknowledged prompt's pending checkpoint before simulating Agent completion.
        const deadline = Date.now() + 15_000;
        const validSendResponseFinished = () =>
          server.state.finishedToolResponses.some(
            ({ name, payload }) =>
              name === "t3_thread_send" &&
              payload.threadId === id &&
              payload.messageId === "message-1" &&
              payload.runId === "run-1",
          );
        while (!validSendResponseFinished() && Date.now() < deadline) {
          const early = await Promise.race([
            run,
            new Promise((resolve) => setTimeout(resolve, 100)),
          ]);
          assert.equal(early, undefined, early?.output);
        }
        assert.ok(
          delivered && validSendResponseFinished(),
          "No task prompt acknowledged",
        );
        await assert.rejects(stat(delivered), { code: "ENOENT" });
        pending = await checkpoint();
        assert.equal(pending.phase, "implementing");
        assert.equal(pending.result, undefined);
        assert.equal(archived, false);
        assert.equal((await fixture()).closed, undefined);
        child.kill("SIGTERM");
        assert.notEqual((await run).code, 0);
        busy = true;
        run = runCli((process) => {
          child = process;
        });
        await waitForOutput(log, /Press q to exit.*Enter would advance/, run);
        assert.match(
          readFileSync(log, "utf8"),
          /finish or stop the turn in T3, then rerun the same command/i,
        );
        child.stdin.write("q\n");
        const failed = await run;
        assert.notEqual(failed.code, 0, failed.output);
        assert.equal(taskReads, 1);
        assert.equal(history.length, 1);
        assert.equal(archived, false);
        assert.equal((await checkpoint()).roles.implement.sessionid, id);
        busy = false;
        if (mode === "recover-enter") {
          run = runCli((process) => {
            child = process;
          });
          await waitForOutput(log, /Press q to exit.*Enter would advance/, run);
          assert.equal(taskReads, 1, "Saved pause must precede retry");
          child.stdin.write("\n");
          await waitForOutput(log, /handoff=/, run);
          const deadline = Date.now() + 10_000;
          while (history.length < 2 && Date.now() < deadline)
            await new Promise((resolve) => setTimeout(resolve, 50));
          assert.equal(history.length, 2);
          assert.equal(taskReads, 3);
        }
        await writeFile(
          `${delivered}.tmp`,
          JSON.stringify({
            outcome: "no_change",
            summary: "Fixture already satisfied.",
            commits: [],
            findings_file: null,
            pr_title: "Fixture",
            pr_body: "Closes #42",
          }),
        );
        await rename(`${delivered}.tmp`, delivered);
        if (mode === "recover-handoff") run = runCli();
        const result = await run;
        assert.equal(result.code, 0, result.output);
        assert.ok(
          result.output.includes(
            `Issue #42 implement sessionid=${id} handoff=${delivered}`,
          ),
          result.output,
        );
        assert.equal(history.length, mode === "recover-enter" ? 2 : 1);
        if (mode === "recover-handoff") {
          assert.equal(
            taskReads,
            1,
            "Existing handoff must bypass thread execution",
          );
          assert.equal(archived, false, "Unowned thread is retained");
        } else assert.ok(archived && accepted);
        assert.equal((await fixture()).closed, true);
      } finally {
        child?.kill("SIGTERM");
        await server.close();
      }
    },
  );

async function waitForOutput(log, pattern, run) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (pattern.test(readFileSync(log, "utf8"))) return;
    const early = await Promise.race([
      run,
      new Promise((resolve) => setTimeout(resolve, 50)),
    ]);
    assert.equal(early, undefined, early?.output);
  }
  assert.fail(`No ${pattern} in output: ${readFileSync(log, "utf8")}`);
}

for (const mode of [
  "create auth loss",
  "close auth loss",
  "lost archive reply",
  "exit after accepted handoff",
  "execute auth loss",
  "submit auth loss",
])
  test(
    `Core recovery: ${mode}`,
    { skip: process.platform === "win32" },
    async () => {
      const { log, fixture, checkpoint, initialize, runCli } =
        await coreFixture();
      const marker = "Implement the fixture exactly once.";
      const id = "owned-task";
      const projectId = "project";
      const history = [];
      const reads = [];
      let thread,
        launchAttempts = 0,
        sendAttempts = 0,
        archiveAttempts = 0,
        child;
      const server = await substitute(async (name, args, authorization) => {
        if (name === "t3_thread_read" && args.threadId === "launcher-thread") {
          if (mode === "create auth loss" && !server.state.replacementToken)
            server.state.authorizations.clear();
          return { thread: { threadId: "launcher-thread", projectId } };
        }
        if (name === "t3_thread_launch") {
          launchAttempts++;
          if (mode === "execute auth loss") return unauthorized;
          assert.equal(thread, undefined);
          if (mode === "create auth loss")
            assert.equal(
              authorization,
              `Bearer ${server.state.replacementToken}`,
            );
          thread = {
            threadId: id,
            projectId,
            archived: false,
            activeRunId: null,
            status: "completed",
            worktreePath: args.workspaceStrategy.worktreePath,
            title: args.title,
          };
          return { threadId: id, projectId, runId: null };
        }
        assert.equal(args.threadId, id);
        assert.ok(thread);
        if (name === "t3_thread_read") {
          reads.push({ archived: thread.archived, authorization });
          return { thread };
        }
        if (name === "t3_queue") return { items: [], nextCursor: null };
        if (name === "t3_thread_send") {
          sendAttempts++;
          const saved = await checkpoint();
          assert.equal(saved.roles.implement.sessionid, id);
          if (sendAttempts === 1) assert.ok(args.message.includes(marker));
          else assert.equal(args.message, "continue");
          if (mode === "submit auth loss" && sendAttempts === 1)
            return unauthorized;
          history.push(args.message);
          if (mode === "close auth loss") server.state.authorizations.clear();
          await writeFile(
            `${saved.invocation.path}.tmp`,
            JSON.stringify({
              outcome: "no_change",
              summary: "Fixture already satisfied.",
              commits: [],
              findings_file: null,
              pr_title: "Fixture",
              pr_body: "Closes #42",
            }),
          );
          await rename(`${saved.invocation.path}.tmp`, saved.invocation.path);
          return { threadId: id, messageId: "message", runId: "run" };
        }
        if (name === "t3_thread_organize") {
          assert.deepEqual(args, { threadId: id, action: "archive" });
          archiveAttempts++;
          const saved = await checkpoint();
          assert.equal(saved.phase, "implementation_completed");
          assert.equal(saved.result.outcome, "no_change");
          if (mode === "exit after accepted handoff") return undefined;
          thread.archived = true;
          if (mode === "lost archive reply") return undefined;
          return { sequence: 1 };
        }
        assert.fail(`Unexpected T3 tool ${name}`);
      });
      const start = () =>
        runCli((process) => {
          child = process;
        });
      const signIn = async () => {
        server.state.replacementToken = `replacement-${randomUUID()}`;
        const result = await cli(["auth", "login", server.endpoint], {
          approve,
        });
        assert.equal(result.code, 0, result.output);
      };
      const checkLogin = (output) => {
        assert.ok(
          output.includes(`issue-runner-t3 auth login ${server.endpoint}`),
          output,
        );
        assert.ok(!output.includes(server.token));
      };
      try {
        await initialize(server.endpoint, false, marker);
        let run = start();
        if (mode === "submit auth loss") {
          const rejected = await run;
          assert.notEqual(rejected.code, 0, rejected.output);
          checkLogin(rejected.output);
          assert.equal(history.length, 0);
          const saved = await checkpoint();
          assert.equal(saved.roles.implement.sessionid, id);
          assert.equal(saved.pendingPrompt, undefined);
          await signIn();
          run = start();
        } else if (mode === "execute auth loss") {
          await waitForOutput(
            log,
            /Command will not be replayed:.*HTTP 401/,
            run,
          );
          checkLogin(readFileSync(log, "utf8"));
          assert.equal(
            (await checkpoint()).roles.implement?.sessionid,
            undefined,
          );
          await signIn();
          child.stdin.write("q\n");
          assert.notEqual((await run).code, 0);
          run = start();
          await waitForOutput(
            log,
            /Enter to restart the entire Issue #42/,
            run,
          );
          child.stdin.write("q\n");
          assert.notEqual((await run).code, 0);
          assert.equal(launchAttempts, 1);
          assert.equal(sendAttempts, 0);
          return;
        } else {
          const authLoss = mode.endsWith("auth loss");
          await waitForOutput(
            log,
            authLoss
              ? /Operation failed:.*HTTP 401/
              : /Operation failed:.*t3_thread_organize/,
            run,
          );
          if (authLoss) {
            checkLogin(readFileSync(log, "utf8"));
            await signIn();
          }
          if (mode !== "create auth loss") {
            const saved = await checkpoint();
            assert.equal(saved.roles.implement.sessionid, id);
            assert.equal(saved.phase, "implementation_completed");
            assert.equal(saved.result.outcome, "no_change");
            assert.equal(archiveAttempts, authLoss ? 0 : 1);
            assert.equal((await fixture()).closed, undefined);
          } else assert.equal(launchAttempts, 0);
          if (mode === "exit after accepted handoff") {
            assert.match(
              readFileSync(log, "utf8"),
              /owned-task may need manual archival/,
            );
            child.stdin.write("q\n");
            assert.notEqual((await run).code, 0);
            run = start();
          } else child.stdin.write("\n");
        }
        const result = await run;
        assert.equal(result.code, 0, result.output);
        assert.equal(launchAttempts, 1);
        assert.equal(history.length, 1);
        assert.equal(sendAttempts, mode === "submit auth loss" ? 2 : 1);
        assert.equal(archiveAttempts, 1);
        assert.equal((await fixture()).closed, true);
        assert.equal(thread.archived, mode !== "exit after accepted handoff");
        if (mode === "lost archive reply")
          assert.deepEqual(
            reads.map((read) => read.archived),
            [false, false, true],
          );
        if (mode === "exit after accepted handoff")
          assert.deepEqual(
            reads.map((read) => read.archived),
            [false, false],
          );
        if (mode === "close auth loss")
          assert.ok(
            reads.every(
              (read) =>
                read.authorization ===
                `Bearer ${server.state.replacementToken}`,
            ),
          );
      } finally {
        child?.kill("SIGTERM");
        await server.close();
      }
    },
  );

test(
  "Core Review fix reopens the implementation thread with its history and updated stage title",
  { skip: process.platform === "win32" },
  async () => {
    const { log, fixture, checkpoint, initialize, runCli, commit } =
      await coreFixture();
    const projectId = "launcher-project";
    const threads = new Map();
    let child,
      fix,
      fixed = false,
      secondReview = false;
    const saveHandoff = async (path, result) => {
      await writeFile(`${path}.tmp`, JSON.stringify(result));
      await rename(`${path}.tmp`, path);
    };
    const server = await substitute(async (name, args) => {
      if (name === "t3_thread_read" && args.threadId === "launcher-thread")
        return { thread: { threadId: "launcher-thread", projectId } };
      if (name === "t3_thread_launch") {
        const threadId =
          args.title === "issue-42 implement" ? "implementation" : "review";
        assert.equal(
          threads.has(threadId),
          false,
          "Each role must launch exactly once",
        );
        assert.equal(args.projectId, projectId);
        assert.deepEqual(args.workspaceStrategy, {
          type: "existing_worktree",
          worktreePath: (await fixture()).worktree,
        });
        threads.set(threadId, {
          threadId,
          projectId,
          title: args.title,
          worktreePath: args.workspaceStrategy.worktreePath,
          archived: false,
          activeRunId: null,
          status: "completed",
          modelSelection: args.modelSelection,
          history: [],
        });
        return { threadId, projectId, runId: null };
      }
      const thread = threads.get(args.threadId);
      assert.ok(thread, `Unexpected thread ${args.threadId}`);
      if (name === "t3_thread_read")
        return { thread, recentRuns: [], items: thread.history };
      if (name === "t3_queue") return { items: [], nextCursor: null };
      if (name === "t3_thread_organize") {
        if (args.action === "unarchive") assert.equal(thread.archived, true);
        else assert.equal(args.action, "archive");
        thread.archived = args.action === "archive";
        return { sequence: 1 };
      }
      if (name === "t3_thread_update") {
        assert.equal(args.action, "rename");
        assert.equal(thread.archived, false);
        assert.ok(!("modelSelection" in args));
        thread.title = args.title;
        return { sequence: 2, title: args.title };
      }
      if (name === "t3_thread_send") {
        assert.equal(thread.archived, false);
        const saved = await checkpoint();
        thread.history.push(args.message);
        if (saved.phase === "implementing") {
          assert.equal(args.threadId, "implementation");
          const implementation = await commit(
            thread.worktreePath,
            "Implement fixture",
          );
          await saveHandoff(saved.invocation.path, {
            outcome: "committed",
            summary: "Implemented",
            commits: [implementation],
            findings_file: null,
            pr_title: "Fixture",
            pr_body: "Closes #42",
          });
        } else if (saved.phase === "reviewing" && saved.reviews.length === 1) {
          assert.equal(args.threadId, "review");
          assert.equal(thread.title, "issue-42 review r1");
          const round = saved.reviews[0];
          await writeFile(round.findings, "Fix the fixture.");
          await saveHandoff(round.invocation.path, {
            outcome: "findings",
            summary: "Found a defect",
            commits: [],
            findings_file: round.findings,
          });
        } else if (saved.phase === "fixing_review") {
          assert.equal(args.threadId, "implementation");
          assert.equal(saved.roles.implement.sessionid, "implementation");
          assert.equal(thread.title, "issue-42 fix review r1");
          assert.equal(thread.history.length, 2);
          assert.match(thread.history[0], /Implement the fixture/);
          assert.ok(args.message.includes(saved.reviews[0].findings));
          assert.deepEqual(thread.modelSelection, {
            instanceId: "codex-instance",
            model: "fixture-model",
            options: [{ id: "reasoningEffort", value: "high" }],
          });
          fix = await commit(thread.worktreePath, "Fix Review finding");
          await saveHandoff(saved.reviews[0].fix.invocation.path, {
            outcome: "committed",
            summary: "Fixed",
            commits: [fix],
            findings_file: null,
          });
          fixed = true;
        } else {
          assert.equal(saved.phase, "reviewing");
          assert.equal(saved.reviews.length, 2);
          assert.equal(args.threadId, "review");
          assert.equal(thread.title, "issue-42 review r2");
          assert.deepEqual(saved.reviews[0].fix.result.commits, [fix]);
          secondReview = true;
        }
        return {
          threadId: args.threadId,
          messageId: randomUUID(),
          runId: randomUUID(),
        };
      }
      assert.fail(`Unexpected T3 tool ${name}`);
    });
    try {
      await initialize(server.endpoint, true, "Implement the fixture.");
      const run = runCli((process) => {
        child = process;
      });
      const deadline = Date.now() + 15_000;
      while (!secondReview && Date.now() < deadline) {
        const early = await Promise.race([
          run,
          new Promise((resolve) => setTimeout(resolve, 50)),
        ]);
        assert.equal(early, undefined, early?.output);
      }
      assert.ok(fixed && secondReview, readFileSync(log, "utf8"));
      child.kill("SIGTERM");
      assert.notEqual((await run).code, 0);
      assert.equal(threads.size, 2);
      assert.equal(threads.get("implementation").archived, true);
      assert.equal(threads.get("implementation").history.length, 2);
      assert.equal(threads.get("review").history.length, 2);
    } finally {
      child?.kill("SIGTERM");
      await server.close();
    }
  },
);

test("custom-only browser login, status, and init use the Core templates and retain the endpoint", async () => {
  const server = await substitute();
  try {
    const initArgs = [
      "init",
      "--project",
      "authorized",
      "--mcp-url",
      `${server.endpoint}/`,
    ];
    const unauthorized = await cli(initArgs);
    assert.notEqual(unauthorized.code, 0);
    assert.ok(
      unauthorized.output.includes(`auth login ${server.endpoint}`),
      unauthorized.output,
    );
    await assert.rejects(stat(join(launch, "authorized")), { code: "ENOENT" });
    const login = await cli(["auth", "login", server.endpoint], {
      cwd: home,
      approve,
    });
    assert.equal(login.code, 0, login.output);
    assert.ok(!login.output.includes(server.token));
    const store = join(home, ".issue-runner-t3");
    const [file] = await readdir(store);
    const saved = JSON.parse(await readFile(join(store, file), "utf8"));
    assert.equal(saved.accessToken, server.token);
    assert.equal(saved.scope, server.state.scope);
    assert.ok(saved.expiresAt > Date.now());
    if (process.platform !== "win32") {
      assert.equal((await stat(store)).mode & 0o777, 0o700);
      assert.equal((await stat(join(store, file))).mode & 0o777, 0o600);
    } else {
      execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `
        $ErrorActionPreference = 'Stop'
        $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
        foreach ($path in @($env:TEST_CREDENTIAL_DIR, $env:TEST_CREDENTIAL_FILE)) {
          $acl = Get-Acl -LiteralPath $path
          if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'Credential owner is not the current user' }
          $rules = $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
          if ($rules.Count -eq 0 -or @($rules | Where-Object { $_.IdentityReference -ne $sid }).Count -ne 0) { throw 'Credential ACL is not user-only' }
        }
      `,
        ],
        {
          env: windowsPowerShellEnv({
            TEST_CREDENTIAL_DIR: store,
            TEST_CREDENTIAL_FILE: join(store, file),
          }),
        },
      );
    }
    const before = await stat(join(store, file));
    const status = await cli(["auth", "status", server.endpoint]);
    assert.equal(status.code, 0, status.output);
    assert.ok(status.output.includes(`Authorized for ${server.endpoint}`));
    assert.equal((await stat(join(store, file))).mtimeMs, before.mtimeMs);
    const init = await cli(initArgs);
    assert.equal(init.code, 0, init.output);
    assert.ok(!init.output.includes(server.token));
    const template = await readFile(
      join(
        packageRoot,
        "node_modules",
        "issue-runner-core",
        "templates",
        "config.yaml",
      ),
      "utf8",
    );
    const expected = parse(template);
    expected.terminalPlugins.mcpUrl = server.endpoint;
    const config = await readFile(
      join(launch, "authorized", "config.yaml"),
      "utf8",
    );
    assert.deepEqual(parse(config), expected);
    assert.deepEqual(
      (await readdir(join(launch, "authorized", "prompts"))).sort(),
      ["documentation.md", "implement.md", "review.md"],
    );
    const repeat = await cli(initArgs);
    assert.notEqual(repeat.code, 0);
    assert.match(repeat.output, /already exists/);
    assert.equal(
      await readFile(join(launch, "authorized", "config.yaml"), "utf8"),
      config,
    );
    assert.ok(server.state.reads >= 2);
  } finally {
    await server.close();
  }
});

test("missing credentials prevent Core from creating a Project", async () => {
  const result = await cli(["init", "--project", "unauthorized"]);
  assert.notEqual(result.code, 0, result.output);
  assert.match(result.output, /auth login http:\/\/127\.0\.0\.1:3773\/mcp/);
  await assert.rejects(stat(join(launch, "unauthorized")), { code: "ENOENT" });
  const status = await cli(["auth", "status"]);
  assert.notEqual(status.code, 0);
  assert.match(status.output, /missing/i);
  assert.ok(status.output.includes("http://127.0.0.1:3773/mcp"));
  await assert.rejects(stat(join(home, ".issue-runner-t3")), {
    code: "ENOENT",
  });
});

test("init refuses existing child directories and preserves partial Project output", async () => {
  const server = await substitute();
  try {
    assert.equal(
      (await cli(["auth", "login", server.endpoint], { approve })).code,
      0,
    );
    const init = (key) =>
      cli(["init", "--project", key, "--mcp-url", server.endpoint]);
    const existing = join(launch, "existing");
    await mkdir(existing);
    await writeFile(join(existing, "notes.md"), "Operator work");
    const refused = await init("existing");
    assert.notEqual(refused.code, 0);
    assert.match(refused.output, /destination already exists/);
    assert.deepEqual(await readdir(existing), ["notes.md"]);
    assert.equal(
      await readFile(join(existing, "notes.md"), "utf8"),
      "Operator work",
    );

    const template = join(
      packageRoot,
      "node_modules",
      "issue-runner-core",
      "templates",
      "prompts",
      "review.md",
    );
    await rename(template, `${template}.unavailable`);
    try {
      const failed = await init("partial");
      assert.notEqual(failed.code, 0);
      assert.match(failed.output, /partial output was retained/);
    } finally {
      await rename(`${template}.unavailable`, template);
    }
    const partial = join(launch, "partial");
    const config = await readFile(join(partial, "config.yaml"), "utf8");
    const prompt = await readFile(
      join(partial, "prompts", "implement.md"),
      "utf8",
    );
    const repeat = await init("partial");
    assert.notEqual(repeat.code, 0);
    assert.match(repeat.output, /destination already exists/);
    assert.equal(await readFile(join(partial, "config.yaml"), "utf8"), config);
    assert.equal(
      await readFile(join(partial, "prompts", "implement.md"), "utf8"),
      prompt,
    );
    assert.deepEqual(await readdir(join(partial, "prompts")), ["implement.md"]);
  } finally {
    await server.close();
  }
});

test("normalized endpoints share credentials and distinct endpoints are isolated", async () => {
  const a = await substitute();
  const b = await substitute();
  try {
    assert.equal(
      (await cli(["auth", "login", `${a.endpoint}/`], { approve })).code,
      0,
    );
    assert.equal((await cli(["auth", "status", a.endpoint])).code, 0);
    const other = await cli(["auth", "status", b.endpoint]);
    assert.notEqual(other.code, 0);
    assert.match(other.output, /missing/i);
    assert.equal(b.state.reads, 0);
    assert.equal(
      (await cli(["auth", "login", b.endpoint], { approve })).code,
      0,
    );
    assert.equal((await cli(["auth", "status", a.endpoint])).code, 0);
    assert.equal((await cli(["auth", "status", b.endpoint])).code, 0);
    assert.equal((await readdir(join(home, ".issue-runner-t3"))).length, 2);
  } finally {
    await a.close();
    await b.close();
  }
});

test("status refuses non-private credential directories and files without repairing permissions", async () => {
  const server = await substitute();
  try {
    assert.equal(
      (await cli(["auth", "login", server.endpoint], { approve })).code,
      0,
    );
    const store = join(home, ".issue-runner-t3");
    const [file] = await readdir(store);
    const status = () => cli(["auth", "status", server.endpoint]);
    for (const [path, widerMode] of [
      [store, 0o755],
      [join(store, file), 0o644],
    ]) {
      if (process.platform === "win32") {
        const ps = (script, env = {}) =>
          execFileSync(
            "powershell.exe",
            [
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              `$ErrorActionPreference = 'Stop'; ${script}`,
            ],
            {
              env: windowsPowerShellEnv({ TEST_CREDENTIAL_PATH: path, ...env }),
              encoding: "utf8",
            },
          ).trim();
        const acl = () =>
          ps("(Get-Acl -LiteralPath $env:TEST_CREDENTIAL_PATH).Sddl");
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
  } finally {
    await server.close();
  }
});

test("status and the command gate report rejected, insufficient, expired, and unreachable access without leaking tokens", async () => {
  const server = await substitute();
  try {
    const project = join(launch, "custom");
    await mkdir(project);
    await writeFile(
      join(project, "config.yaml"),
      `terminalPlugins:\n  agentStartDelay: 0\n  mcpUrl: ${server.endpoint}/\n`,
    );
    const run = () =>
      cli(["run", "--project=custom", "--issue", "1"], {
        env: { T3CODE_THREAD_ID: "launcher" },
      });
    const missing = await run();
    assert.notEqual(missing.code, 0);
    assert.ok(
      missing.output.includes(`auth login ${server.endpoint}`),
      missing.output,
    );
    assert.equal(
      (await cli(["auth", "login", server.endpoint], { approve })).code,
      0,
    );
    const status = () => cli(["auth", "status", server.endpoint]);
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
    const store = join(home, ".issue-runner-t3");
    const [filename] = await readdir(store);
    const credentialFile = join(store, filename);
    const saved = await readFile(credentialFile, "utf8");
    server.state.scope = "orchestration:read";
    assert.notEqual(
      (await cli(["auth", "login", server.endpoint], { approve })).code,
      0,
    );
    assert.equal(await readFile(credentialFile, "utf8"), saved);
    assert.equal((await status()).code, 0);
    await writeFile(
      credentialFile,
      JSON.stringify({ ...JSON.parse(saved), scope: "orchestration:read" }),
    );
    const insufficient = await status();
    assert.notEqual(insufficient.code, 0);
    assert.match(insufficient.output, /insufficient.*orchestration:operate/i);
    await writeFile(credentialFile, saved);
    server.state.scope = "orchestration:read orchestration:operate";
    server.state.expires = 0;
    assert.notEqual(
      (await cli(["auth", "login", server.endpoint], { approve })).code,
      0,
    );
    assert.equal(await readFile(credentialFile, "utf8"), saved);
    assert.equal((await status()).code, 0);
    await writeFile(
      credentialFile,
      JSON.stringify({ ...JSON.parse(saved), expiresAt: Date.now() - 1000 }),
    );
    const expired = await run();
    assert.notEqual(expired.code, 0);
    assert.match(expired.output, /expired/i);
    assert.ok(expired.output.includes(`auth login ${server.endpoint}`));
    server.state.expires = 3600;
    assert.equal(
      (await cli(["auth", "login", server.endpoint], { approve })).code,
      0,
    );
  } finally {
    await server.close();
  }
  const offline = await cli(["auth", "status", server.endpoint]);
  assert.notEqual(offline.code, 0);
  assert.match(offline.output, /reachable/i);
  assert.ok(!offline.output.includes(server.token));
});

test("the browser callback rejects an incorrect state and does not save a denied grant", async () => {
  const server = await substitute();
  try {
    const deny = await cli(["auth", "login", server.endpoint], {
      approve: async (url) => {
        const response = await fetch(url, { redirect: "manual" });
        assert.equal(response.status, 302);
        const callback = new URL(response.headers.get("location"));
        const invalid = new URL(callback);
        invalid.searchParams.set("state", "wrong");
        assert.equal((await fetch(invalid)).status, 400);
        callback.searchParams.delete("code");
        callback.searchParams.set("error", "access_denied");
        assert.equal((await fetch(callback)).status, 200);
      },
    });
    assert.notEqual(deny.code, 0);
    assert.match(deny.output, /denied/i);
    await assert.rejects(stat(join(home, ".issue-runner-t3")), {
      code: "ENOENT",
    });
  } finally {
    await server.close();
  }
});

test("a stalled MCP initialization notification times out before status or init can hang", async () => {
  const server = await substitute();
  try {
    assert.equal(
      (await cli(["auth", "login", server.endpoint], { approve })).code,
      0,
    );
    server.state.stallInitialized = true;
    const started = Date.now();
    const timeout = 20_000;
    const results = await Promise.all([
      cli(["auth", "status", server.endpoint], { timeout }),
      cli(["init", "--project", "stalled", "--mcp-url", server.endpoint], {
        timeout,
      }),
    ]);
    assert.equal(server.state.stalled, 2);
    assert.ok(Date.now() - started < timeout);
    for (const result of results) {
      assert.equal(result.code, 1, result.output);
      assert.match(result.output, /timed out.*reachable/i);
      assert.ok(!result.output.includes(server.token));
    }
    await assert.rejects(stat(join(launch, "stalled")), { code: "ENOENT" });
  } finally {
    await server.close();
  }
});
