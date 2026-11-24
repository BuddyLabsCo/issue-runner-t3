import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { loginCommand, requireCredential } from './credentials.js';

export async function callMcp(endpoint: string, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
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
    const result = CallToolResultSchema.parse(await client.callTool({ name, arguments: args }, undefined, { timeout: 10_000 }));
    const text = result.content.find(item => item.type === 'text');
    const payload: unknown = result.structuredContent ?? (text?.type === 'text' ? JSON.parse(text.text) : undefined);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('MCP call failed');
    const data = payload as Record<string, unknown>;
    if (data._tag === 'OrchestratorMcpFailure' || typeof data.code === 'string') {
      return { code: data.code, message: typeof data.message === 'string' ? data.message.replaceAll(credential.accessToken, '[redacted]') : 'Request rejected' };
    }
    if (result.isError) throw new Error('MCP call failed');
    return data;
  } catch (error) {
    if (error instanceof StreamableHTTPError && error.code === 401) {
      throw new Error(`Credentials rejected by ${endpoint} (HTTP 401). Sign in again: ${loginCommand(endpoint)}.`);
    }
    if (error instanceof StreamableHTTPError && error.code === 403) {
      throw new Error(`Insufficient access at ${endpoint} (HTTP 403). Run ${loginCommand(endpoint)} and approve operation access.`);
    }
    throw new Error(`Cannot complete an authenticated MCP ${name === 't3_project_list' ? 'read' : name} at ${endpoint}${deadline.aborted ? ': timed out' : ''}. Check that T3 is running and reachable.`);
  } finally {
    await transport.close();
  }
}

export async function checkAuthorization(endpoint: string): Promise<void> {
  const payload = await callMcp(endpoint, 't3_project_list', { limit: 1 });
  if (!Array.isArray(payload.projects)) throw new Error(`Cannot complete an authenticated MCP read at ${endpoint}. Check that T3 is running and reachable.`);
}
