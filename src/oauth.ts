import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import open from 'open';
import { operateScope, saveCredential } from './credentials.js';

async function oauthPost(url: URL, body: string | URLSearchParams, contentType: string): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST', body, headers: { 'Content-Type': contentType },
      redirect: 'error', signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error('Cannot reach the T3 authorization server. Check the MCP URL and that T3 is running.');
  }
  if (!response.ok) throw new Error(`T3 authorization request failed (HTTP ${response.status}). Start login again.`);
  try {
    const data: unknown = await response.json();
    if (!data || typeof data !== 'object') throw new Error();
    return data as Record<string, unknown>;
  } catch {
    throw new Error('Invalid response from the T3 authorization server.');
  }
}

export async function login(endpoint: string): Promise<void> {
  // Public T3 Code 0.1.11 OAuth endpoints are bound to the MCP resource's origin.
  const issuer = new URL(endpoint).origin;
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  let complete!: (code: string | null) => void;
  const callback = new Promise<string | null>(resolve => { complete = resolve; });
  const server = createServer((req, res) => {
    const url = URL.parse(req.url ?? '/', 'http://127.0.0.1');
    if (!url || req.method !== 'GET' || url.pathname !== '/callback' ||
        url.searchParams.get('state') !== state || url.searchParams.get('iss') !== issuer) {
      res.writeHead(400).end('Invalid authorization callback.');
      return;
    }
    const code = url.searchParams.has('error') ? null : url.searchParams.get('code');
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
    res.end(code ? 'Approval received. Return to issue-runner-t3 to finish signing in.' : 'Authorization was not granted. Return to issue-runner-t3.');
    complete(code);
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}/callback`;
    const registration = await oauthPost(new URL('/oauth/mcp/register', issuer), JSON.stringify({
      client_name: 'issue-runner-t3', redirect_uris: [redirectUri], token_endpoint_auth_method: 'none',
    }), 'application/json');
    if (typeof registration.client_id !== 'string' || !registration.client_id) throw new Error('T3 did not register the OAuth client.');
    const authorization = new URL('/oauth/mcp/authorize', issuer);
    authorization.search = new URLSearchParams({
      response_type: 'code', client_id: registration.client_id, redirect_uri: redirectUri,
      code_challenge: challenge, code_challenge_method: 'S256', state,
      resource: endpoint, scope: `orchestration:read ${operateScope}`,
    }).toString();
    console.log(`Approve access: ${authorization.href}`);
    try {
      await open(authorization.href, process.env.BROWSER ? { app: { name: process.env.BROWSER } } : undefined);
    } catch {
      console.log('Could not open the browser automatically. Open the approval URL above.');
    }
    timer = setTimeout(() => complete(null), 300_000);
    const code = await callback;
    if (!code) throw new Error('Authorization denied or timed out. Start login again.');
    const token = await oauthPost(new URL('/oauth/mcp/token', issuer), new URLSearchParams({
      grant_type: 'authorization_code', client_id: registration.client_id, redirect_uri: redirectUri,
      code, code_verifier: verifier, resource: endpoint,
    }), 'application/x-www-form-urlencoded');
    if (typeof token.access_token !== 'string' || !token.access_token ||
        typeof token.token_type !== 'string' || token.token_type.toLowerCase() !== 'bearer' ||
        typeof token.expires_in !== 'number' || !Number.isFinite(token.expires_in) || token.expires_in < 0 ||
        typeof token.scope !== 'string') {
      throw new Error('T3 returned an invalid token response. Start login again.');
    }
    await saveCredential(endpoint, { accessToken: token.access_token, expiresAt: Date.now() + token.expires_in * 1000, scope: token.scope });
  } finally {
    clearTimeout(timer);
    server.closeAllConnections();
    server.close();
  }
}
