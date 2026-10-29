/**
 * A token Clerk verifies is turned into the MCP SDK's `AuthInfo` by Clerk's own
 * `verifyClerkToken` (`@clerk/mcp-tools`). A verified token it cannot attribute
 * (no OAuth client, scopes or user) is refused like an invalid one: 401 with
 * the `WWW-Authenticate` header that sends the client back through OAuth,
 * before any workspace lookup.
 *
 * Clerk's request authentication is stubbed; the converter is the real one.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const clerkAuth = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));

vi.mock('@clerk/backend', () => ({
  createClerkClient: () => ({
    authenticateRequest: async () => ({ reason: null, toAuth: () => clerkAuth.current }),
  }),
}));

import { Hono } from 'hono';
import { authMiddleware } from './auth';
import type { HonoEnv } from '../lib/api-types';

function call() {
  const app = new Hono<HonoEnv>();
  app.all('/mcp', authMiddleware, (c) => c.json({ reached: true }));
  return app.request(
    '/mcp',
    { method: 'POST', headers: { Authorization: 'Bearer oat_opaque' } },
    {
      CLERK_SECRET_KEY: 'sk_test',
      CLERK_PUBLISHABLE_KEY: 'pk_test_Zm9vLmNsZXJrLmFjY291bnRzLmRldiQ',
      MCP_SERVER_URL: 'https://mcp.test',
    },
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('mcp-server · authMiddleware · Clerk AuthInfo', () => {
  it.each([
    ['an OAuth client', { clientId: null }],
    ['scopes', { scopes: null }],
    ['a user', { userId: null }],
  ])('refuses a verified token without %s', async (_label, missing) => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    clerkAuth.current = {
      isAuthenticated: true,
      tokenType: 'oauth_token',
      id: 'oat_1',
      userId: 'user_1',
      clientId: 'client_1',
      scopes: ['user:org:read'],
      ...missing,
    };

    const res = await call();

    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toBe(
      'Bearer resource_metadata="https://mcp.test/.well-known/oauth-protected-resource"',
    );
    expect(await res.json()).toEqual({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Invalid or expired access token.' },
      id: null,
    });
    expect(consoleError.mock.calls.flat().join(' ')).toContain(
      'token oat_1 verified by Clerk but has no client, scopes or user',
    );
  });
});
