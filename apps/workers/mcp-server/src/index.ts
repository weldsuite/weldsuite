import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { HonoEnv } from './lib/api-types';
import { createMcpServer } from './lib/mcp-server';
import { authMiddleware } from './middleware/auth';
import { rateLimitMiddleware } from './middleware/rate-limit';

export { RateLimiter } from './durable-objects/rate-limiter';

const app = new Hono<HonoEnv>();

// Global middleware
app.use('*', logger());
app.use('*', cors());

// Health check (unauthenticated)
app.get('/health', (c) =>
  c.json({ status: 'ok', service: 'weldsuite-mcp-server', timestamp: new Date().toISOString() }),
);

// Robots
app.get('/robots.txt', (c) => c.text('User-agent: *\nDisallow: /'));

// MCP endpoint — handles all MCP protocol messages
app.all('/mcp', authMiddleware, rateLimitMiddleware, async (c) => {
  const session = c.get('apiSession');
  const server = await createMcpServer(session, c.env.EXTERNAL_API_BASE_URL, c.env.EXTERNAL_API);

  // Stateless transport: no session ID, each request is independent
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
  let parsedBody: unknown | undefined;
  if (c.req.method === 'POST') {
    parsedBody = await c.req.json();
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

  const response = await transport.handleRequest(c.req.raw, { parsedBody });

  // Clean up transport (don't close the server — it's per-request anyway)
  await transport.close();

  return response;
});

// 404 for everything else
app.notFound((c) =>
  c.json(
    {
      jsonrpc: '2.0',
      error: { code: -32600, message: 'Not found. The MCP endpoint is POST /mcp' },
      id: null,
    },
    404,
  ),
);

// Global error handler
app.onError((err, c) => {
  console.error('[MCP Server] Unhandled error:', err);
  return c.json(
    {
      jsonrpc: '2.0',
      error: { code: -32603, message: 'Internal server error' },
      id: null,
    },
    500,
  );
});

export default app;
