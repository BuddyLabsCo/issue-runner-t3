import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import "node:path";
import "node:os";

const record = (value) =>
  appendFileSync(process.env.RPC_LOG, `${JSON.stringify(value)}\n`);
const mode = process.env.RPC_MODE;
// Exercise command selection without changing the fixture's native filesystem paths.
if (process.env.RPC_PLATFORM)
  Object.defineProperty(process, "platform", {
    value: process.env.RPC_PLATFORM,
  });

childProcess.execFileSync = (file, args, options) => {
  assert.equal(file, "t3");
  assert.equal(options.shell, process.platform === "win32");
  record({ args });
  if (args[0] === "thread") return "{}";
  assert.deepEqual(args, [
    "auth",
    "session",
    "issue",
    "--scope",
    "terminal:operate",
    "--ttl",
    "5m",
    "--token-only",
  ]);
  return "fixture-token\n";
};
syncBuiltinESMExports();

globalThis.fetch = async (url, options) => {
  assert.equal(
    String(url),
    "http://127.0.0.1:4242/api/auth/websocket-ticket/rpc",
  );
  assert.equal(options.method, "POST");
  assert.equal(options.headers.Authorization, "Bearer fixture-token");
  assert.equal(options.redirect, "error");
  record({ ticket: true });
  return Response.json({ ticket: "fixture-ticket" });
};

globalThis.WebSocket = class extends EventTarget {
  constructor(url) {
    super();
    assert.equal(url.origin, "ws://127.0.0.1:4242");
    assert.equal(url.pathname, "/ws");
    assert.equal(url.searchParams.get("wsTicket"), "fixture-ticket");
    queueMicrotask(() => this.dispatchEvent(new Event("open")));
  }
  send(message) {
    const request = JSON.parse(message);
    assert.equal(request._tag, "Request");
    record(request);
    const { tag, payload } = request;
    assert.ok(["terminal.open", "terminal.write"].includes(tag));
    const exit =
      mode === "reject-write" && tag === "terminal.write"
        ? { _tag: "Failure", cause: [] }
        : {
            _tag: "Success",
            value:
              tag === "terminal.open"
                ? {
                    ...payload,
                    status: mode === "failed-open" ? "error" : "running",
                    ...(mode === "wrong-thread"
                      ? { threadId: "other-thread" }
                      : {}),
                  }
                : undefined,
          };
    queueMicrotask(() =>
      this.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ _tag: "Exit", requestId: request.id, exit }),
        }),
      ),
    );
  }
  close() {
    record({ closed: true });
  }
};
