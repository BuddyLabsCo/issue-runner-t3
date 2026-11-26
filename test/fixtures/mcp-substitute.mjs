import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";

export const unauthorized = Symbol("unauthorized");
function replyToTool(res, rpc, payload, state, json) {
  if (payload === unauthorized) return json({ error: "invalid_token" }, 401);
  if (payload === undefined) return res.destroy();
  res.once("finish", () =>
    state.finishedToolResponses.push({ name: rpc.params.name, payload }),
  );
  return json({
    jsonrpc: "2.0",
    id: rpc.id,
    result: state.structuredContent
      ? { structuredContent: payload, content: [] }
      : { content: [{ type: "text", text: JSON.stringify(payload) }] },
  });
}

export async function substitute(
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
    structuredContent: false,
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
        return replyToTool(res, rpc, payload, state, json);
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
    close: (force = false) =>
      new Promise((resolve) => {
        server.close(resolve);
        if (force) server.closeAllConnections();
      }),
  };
}
