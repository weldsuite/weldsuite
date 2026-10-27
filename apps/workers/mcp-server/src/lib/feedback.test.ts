/**
 * Agent feedback: `submit_feedback` (Clerk's `@clerk/mcp-tools/feedback`) is on
 * every session's server and stores reports on the Clerk instance that owns
 * CLERK_SECRET_KEY. Driven through `serveMcpRequest`, the stateless transport
 * `/mcp` uses, with the Clerk-built `AuthInfo` the auth middleware hands it:
 * that is what attributes a report to the member and their OAuth client.
 *
 * Clerk's Backend API is stubbed (global `fetch`).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifyClerkToken } from '@clerk/mcp-tools/server';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { createMcpServer } from './mcp-server';
import { serveMcpRequest } from './mcp-transport';
import type { McpSession } from './api-types';
import type { Env } from '../types/env';

const SECRET_KEY = 'sk_test_feedback';

const session: McpSession = {
  tokenId: 'oat_1',
  userId: 'user_1',
  clerkOrgId: 'org_1',
  workspaceId: 'ws_1',
  workspaceName: 'Acme',
  tier: 'business',
  databaseUrl: 'postgres://unused',
  // One read grant: `search_contacts` and `get_contact`, nothing that loads
  // WeldApps or WeldObjects tools from a database.
  permissions: ['contacts:read'],
  permissionDenies: [],
  role: 'MEMBER',
  clientId: 'client_1',
  licensedApps: null,
};

const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;

/** The `AuthInfo` the auth middleware builds for a Clerk OAuth token. */
const clerkAuthInfo = verifyClerkToken(
  {
    isAuthenticated: true,
    tokenType: 'oauth_token',
    id: 'oat_1',
    subject: 'user_1',
    userId: 'user_1',
    clientId: 'client_1',
    scopes: ['user:org:read'],
  } as unknown as Parameters<typeof verifyClerkToken>[0],
  'oat_opaque',
);

async function rpc(method: string, params: Record<string, unknown>, options: { env?: Partial<Env>; authInfo?: AuthInfo } = {}) {
  const env = { CLERK_SECRET_KEY: SECRET_KEY, ...options.env } as unknown as Env;
  const server = await createMcpServer(session, env, ctx);
  const res = await serveMcpRequest(
    server,
    new Request('https://mcp.weldsuite.org/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'User-Agent': 'claude-code/2.1.0',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }),
    options.authInfo,
  );
  return (await res.json()) as { result?: any; error?: unknown };
}

const REPORT = {
  kind: 'missing',
  task: 'Merge two duplicate contacts',
  description: 'Searched contacts, found both, but no tool merges them.',
  impact: 'blocked',
  operation: 'mcp__weldsuite__update_contact',
};

/** Stub Clerk's `POST /v1/feedback`; returns the captured requests. */
function stubClerk(reply: () => Response = () => Response.json({ id: 'fb_1', created_at: '2026-10-27T12:00:00Z' })) {
  const calls: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
      return reply();
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('agent feedback', () => {
  it('lists submit_feedback next to the tools the member’s role allows', async () => {
    const { result } = await rpc('tools/list', {});
    expect(result.tools.map((t: { name: string }) => t.name).sort()).toEqual([
      'get_contact',
      'search_contacts',
      'submit_feedback',
    ]);
  });

  it('stores the report on the Clerk instance, attributed to the member and their OAuth client', async () => {
    const calls = stubClerk();

    const { result } = await rpc('tools/call', { name: 'submit_feedback', arguments: REPORT }, { authInfo: clerkAuthInfo });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({ feedback_id: 'fb_1', received: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.clerk.com/v1/feedback');
    expect(calls[0]!.headers.get('authorization')).toBe(`Bearer ${SECRET_KEY}`);
    expect(calls[0]!.body).toMatchObject({
      kind: 'missing',
      task: REPORT.task,
      impact: 'blocked',
      // Clerk strips the client's `mcp__<server>__` prefix.
      operation: 'update_contact',
      user_id: 'user_1',
      client_id: 'client_1',
      // The source defaults to the host, which tells mcp-test from local dev.
      source: { type: 'mcp', name: 'mcp.weldsuite.org', version: '1.0.0' },
      reporter: { type: 'agent', name: 'claude-code', version: '2.1.0' },
    });
  });

  it('sends no user when the request carried no Clerk AuthInfo', async () => {
    const calls = stubClerk();

    await rpc('tools/call', { name: 'submit_feedback', arguments: REPORT });

    expect(calls[0]!.body).not.toHaveProperty('user_id');
    expect(calls[0]!.body).not.toHaveProperty('client_id');
  });

  it('tells the agent not to retry when Clerk refuses the report', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    stubClerk(() => Response.json({ errors: [{ code: 'too_many_requests' }] }, { status: 429 }));

    const { result } = await rpc('tools/call', { name: 'submit_feedback', arguments: REPORT }, { authInfo: clerkAuthInfo });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('Feedback limit reached for now. Do not retry; continue with the task.');
  });

  it('leaves the tool out, rather than failing the server, when CLERK_SECRET_KEY is unset', async () => {
    const { result } = await rpc('tools/list', {}, { env: { CLERK_SECRET_KEY: '' } });
    expect(result.tools.map((t: { name: string }) => t.name).sort()).toEqual(['get_contact', 'search_contacts']);
  });
});
