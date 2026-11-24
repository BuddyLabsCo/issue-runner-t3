import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { loginCommand, requireCredential } from './credentials.js';

export async function checkAuthorization(endpoint: string): Promise<void> {
  const credential = await requireCredential(endpoint);
  const deadline = AbortSignal.timeout(10_000);
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: { headers: { Authorization: `Bearer ${credential.accessToken}` }, redirect: 'error' },
    // Notifications and transport negotiation do not have MCP request timeouts.
    fetch: (url, init) => fetch(url, {
      ...init,
      signal: init?.signal ? AbortSignal.any([deadline, init.signal]) : deadline,
    }),
  });
  const client = new Client({ name: 'issue-runner-t3', version: '0.1.0' });
  try {
    await client.connect(transport, { timeout: 10_000 });
    const result = CallToolResultSchema.parse(await client.callTool({ name: 't3_project_list', arguments: { limit: 1 } }, undefined, { timeout: 10_000 }));
    if (result.isError) throw new Error('MCP read failed');
    const text = result.content.find(item => item.type === 'text');
    const payload: unknown = result.structuredContent ?? (text?.type === 'text' ? JSON.parse(text.text) : undefined);
    // T3 can return a typed failure as JSON text, without an MCP isError flag.
    if (!payload || typeof payload !== 'object' || !('projects' in payload) || !Array.isArray(payload.projects)) throw new Error('MCP read failed');
  } catch (error) {
    if (error instanceof StreamableHTTPError && error.code === 401) {
      throw new Error(`Credentials rejected by ${endpoint} (HTTP 401). Sign in again: ${loginCommand(endpoint)}.`);
    }
    if (error instanceof StreamableHTTPError && error.code === 403) {
      throw new Error(`Insufficient access at ${endpoint} (HTTP 403). Run ${loginCommand(endpoint)} and approve operation access.`);
    }
    throw new Error(`Cannot complete an authenticated MCP read at ${endpoint}${deadline.aborted ? ': timed out' : ''}. Check that T3 is running and reachable.`);
  } finally {
    await transport.close();
  }
}
