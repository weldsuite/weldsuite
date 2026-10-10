/**
 * The MCP server's internal API applies the app licence before any route: a
 * licensed (partner-managed) workspace's tool calls reach only the modules
 * its apps read. Same module table as external-api (`@weldsuite/api-modules`).
 */

import { describe, it, expect } from 'vitest';
import { INTERNAL_ORIGIN, apiApp, internalEnv } from './app';
import type { McpSession } from '../lib/api-types';
import type { Env } from '../types/env';

const session = (licensedApps: readonly string[] | null): McpSession => ({
  tokenId: 'oat_test',
  userId: 'user_test',
  clerkOrgId: 'org_test',
  workspaceId: 'ws_test',
  workspaceName: 'Test',
  tier: 'enterprise',
  databaseUrl: 'postgres://test:test@localhost:5432/test',
  permissions: ['*'],
  permissionDenies: [],
  role: 'OWNER',
  clientId: null,
  licensedApps,
});

const call = (path: string, licensedApps: readonly string[] | null) =>
  apiApp.fetch(new Request(`${INTERNAL_ORIGIN}${path}`), internalEnv({} as Env, session(licensedApps)));

describe('mcp-server internal API · licence gate', () => {
  it('rejects a tool call into an unlicensed module', async () => {
    const res = await call('/v1/invoices', ['welddesk']);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: 'APP_NOT_LICENSED', details: { app: 'weldbooks' } } });
  });

  it('lets licensed and unrestricted workspaces past the gate', async () => {
    for (const licensedApps of [['welddesk'], null]) {
      // An unknown object 404s in the router, after the gate.
      const res = await call('/v1/no-such-object', licensedApps);
      expect(res.status).toBe(404);
    }
  });
});

describe('mcp-server internal API · read-only gate', () => {
  const readOnlySession = (reason: 'partner_suspended' | 'licence_inactive' = 'partner_suspended'): McpSession => ({
    ...session(['welddesk']),
    readOnly: true,
    readOnlyReason: reason,
  });
  const callWith = (s: McpSession, path: string, method: string) =>
    apiApp.fetch(new Request(`${INTERNAL_ORIGIN}${path}`, { method }), internalEnv({} as Env, s));

  it('refuses writes with 403 WORKSPACE_READ_ONLY and the reason', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await callWith(readOnlySession(), '/v1/tickets/t_1', method);
      expect(res.status, method).toBe(403);
      expect(await res.json()).toMatchObject({
        error: { code: 'WORKSPACE_READ_ONLY', details: { reason: 'partner_suspended' } },
      });
    }
    const res = await callWith(readOnlySession('licence_inactive'), '/v1/tickets', 'POST');
    expect(await res.json()).toMatchObject({ error: { details: { reason: 'licence_inactive' } } });
  });

  it('lets reads and exports past the gate', async () => {
    // An unknown object 404s in the router, after the gate.
    expect((await callWith(readOnlySession(), '/v1/no-such-object', 'GET')).status).toBe(404);
    expect((await callWith(readOnlySession(), '/v1/no-such-object/export', 'POST')).status).toBe(404);
  });

  it('does not touch writable sessions', async () => {
    const res = await callWith({ ...session(['welddesk']), readOnly: false }, '/v1/no-such-object', 'POST');
    expect(res.status).toBe(404);
  });
});
