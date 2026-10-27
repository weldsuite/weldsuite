import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';

/**
 * Answer one MCP HTTP request with `server`, statelessly: no session id, each
 * request independent, JSON responses rather than SSE.
 *
 * `authInfo` reaches every tool handler as `extra.authInfo`. It is the
 * Clerk-built `AuthInfo` from the auth middleware, which is how
 * `submit_feedback` reports know who the agent was working for.
 */
export async function serveMcpRequest(
  server: McpServer,
  request: Request,
  authInfo: AuthInfo | undefined,
): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  await server.connect(transport);

  // Parse body to check if this is a non-initialize request.
  // In stateless mode each HTTP request creates a fresh server, but only
  // the first request from a client is `initialize`. Subsequent requests
  // (tools/list, tools/call) hit an un-initialized server and get rejected.
  // Pre-set the initialized flag so non-initialize requests work.
  let parsedBody: unknown;
  if (request.method === 'POST') {
    parsedBody = await request.json();
    const method = Array.isArray(parsedBody)
      ? (parsedBody as any[])[0]?.method
      : (parsedBody as any)?.method;
    if (method !== 'initialize') {
      // Mark the underlying protocol server as initialized
      (server.server as any)._initialized = true;
      (server.server as any)._clientCapabilities = {};
      (server.server as any)._clientVersion = '2025-03-26';
    }
  }

  const response = await transport.handleRequest(request, { parsedBody, authInfo });

  // Clean up transport (don't close the server — it's per-request anyway)
  await transport.close();

  return response;
}
