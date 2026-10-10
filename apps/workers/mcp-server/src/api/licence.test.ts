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
