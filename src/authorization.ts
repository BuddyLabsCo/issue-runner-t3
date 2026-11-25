import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  CallToolResultSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { setTimeout as sleep } from "node:timers/promises";
import {
  loginCommand,
  requireCredential,
  type Credential,
} from "./credentials.js";

type Retry = {
  acknowledged: (data: Record<string, unknown>) => boolean;
  uncertainEffect: string;
  signal?: AbortSignal;
};
class UncertainMcpError extends Error {}

export async function callMcp(
  endpoint: string,
  name: string,
  args: Record<string, unknown>,
  retry?: Retry,
): Promise<Record<string, unknown>> {
  // The saved bearer token defines T3's deduplication scope. Do not reload it between attempts.
  const credential = await requireCredential(endpoint);
  for (let attempt = 0; ; attempt++) {
    retry?.signal?.throwIfAborted();
    try {
      const data = await attemptMcp(endpoint, name, args, credential, retry);
      // T3 can report an orchestration error after an accepted command fails projection lookup.
      if (retry && data.code === "orchestration_error")
        throw new UncertainMcpError(`${name}: ${data.message}`);
      if (retry && attempt > 0 && "code" in data)
        return {
          ...data,
          message: `${data.message}. ${retry.uncertainEffect}`,
        };
      return data;
    } catch (error) {
      retry?.signal?.throwIfAborted();
      if (!retry) throw error;
      if (!(error instanceof UncertainMcpError)) {
        if (attempt === 0) throw error;
        throw new Error(`${(error as Error).message} ${retry.uncertainEffect}`);
      }
      if (attempt === 2)
        throw new Error(
          `${error.message} Retry budget exhausted after 3 attempts. ${retry.uncertainEffect}`,
        );
      await sleep(5000, undefined, { signal: retry.signal });
    }
  }
}

async function attemptMcp(
  endpoint: string,
  name: string,
  args: Record<string, unknown>,
  credential: Credential,
  retry?: Retry,
): Promise<Record<string, unknown>> {
  const timeout = AbortSignal.timeout(10_000);
  const deadline = retry?.signal
    ? AbortSignal.any([timeout, retry.signal])
    : timeout;
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: {
      headers: { Authorization: `Bearer ${credential.accessToken}` },
      redirect: "error",
    },
    // Notifications and transport negotiation do not have MCP request timeouts.
    fetch: (url, init) =>
      fetch(url, {
        ...init,
        signal: init?.signal
          ? AbortSignal.any([deadline, init.signal])
          : deadline,
      }),
  });
  const client = new Client({ name: "issue-runner-t3", version: "0.1.0" });
  try {
    await client.connect(transport, { timeout: 10_000 });
    const result = CallToolResultSchema.parse(
      await client.callTool({ name, arguments: args }, undefined, {
        timeout: 10_000,
      }),
    );
    const text = result.content.find((item) => item.type === "text");
    const payload: unknown =
      result.structuredContent ??
      (text?.type === "text" ? JSON.parse(text.text) : undefined);
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      throw new Error("MCP call failed");
    const data = payload as Record<string, unknown>;
    if (typeof data.code === "string") {
      return {
        code: data.code,
        message:
          typeof data.message === "string"
            ? data.message.replaceAll(credential.accessToken, "[redacted]")
            : "Request rejected",
      };
    }
    if (result.isError || (retry && !retry.acknowledged(data)))
      throw new Error("MCP call failed");
    return data;
  } catch (error) {
    if (error instanceof StreamableHTTPError && error.code === 401) {
      throw new Error(
        `Credentials rejected by ${endpoint} (HTTP 401). Sign in again: ${loginCommand(endpoint)}.`,
      );
    }
    if (error instanceof StreamableHTTPError && error.code === 403) {
      throw new Error(
        `Insufficient access at ${endpoint} (HTTP 403). Run ${loginCommand(endpoint)} and approve operation access.`,
      );
    }
    if (
      error instanceof StreamableHTTPError &&
      error.code !== undefined &&
      error.code >= 400 &&
      error.code < 500 &&
      error.code !== 408
    ) {
      throw new Error(
        `MCP ${name} rejected by ${endpoint} (HTTP ${error.code}).`,
      );
    }
    if (
      error instanceof McpError &&
      [
        ErrorCode.ParseError,
        ErrorCode.InvalidRequest,
        ErrorCode.MethodNotFound,
        ErrorCode.InvalidParams,
      ].includes(error.code)
    ) {
      throw new Error(
        `MCP ${name} rejected by ${endpoint} (JSON-RPC ${error.code}).`,
      );
    }
    throw new UncertainMcpError(
      `Cannot complete an authenticated MCP ${name === "t3_project_list" ? "read" : name} at ${endpoint}${timeout.aborted ? ": timed out" : ""}. Check that T3 is running and reachable.`,
    );
  } finally {
    await transport.close();
  }
}

export async function checkAuthorization(endpoint: string): Promise<void> {
  const payload = await callMcp(endpoint, "t3_project_list", { limit: 1 });
  if (!Array.isArray(payload.projects))
    throw new Error(
      `Cannot complete an authenticated MCP read at ${endpoint}. Check that T3 is running and reachable.`,
    );
}
