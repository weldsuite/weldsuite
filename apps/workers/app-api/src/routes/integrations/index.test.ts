/**
 * Tests for the ported legacy api-worker integrations surface:
 *  - /connections route ordering vs the generic /:id object CRUD
 *  - sensitive-field stripping on connection lists
 *  - Attio authorize URL (no `scope` param — Attio dashboard-configured)
 *  - unsupported-provider guard on the generic OAuth flow
 *  - permission gates
 *  - internal (service-binding) router: fall-through + secret enforcement
 */

import { describe, it, expect } from 'vitest';
import { createTestApp, createMockDb, permissions } from '../../test/harness';
import { integrationsRoutes } from './index';
import { integrationsInternalRoutes } from './internal';
import type { Database } from '../../db';
import type { Env } from '../../types';

/** Mock db whose select().from().where().orderBy() resolves to `rows`. */
function listDb(rows: unknown[]): Database {
  const chain = {
    from: () => chain,
    where: () => chain,
    orderBy: () => Promise.resolve(rows),
  };
  return createMockDb({ select: () => chain } as unknown as Partial<Database>);
}

const kvStub = { put: async () => {}, get: async () => null, delete: async () => {} } as unknown as KVNamespace;

describe('GET /api/integrations/connections', () => {
  it('is handled by the connections list route, not the /:id object route', async () => {
    const rows = [
      { id: 'intc_1', provider: 'attio', oauthTokens: { accessToken: 'sec' }, webhookSecret: 'whsec', name: 'Attio CRM' },
    ];
    const { request } = createTestApp('/api/integrations', integrationsRoutes, {
      context: { tenantDb: listDb(rows), permissions: permissions('integrations:read') },
    });

    const res = await request('/api/integrations/connections');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<Record<string, unknown>> };
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data[0].id).toBe('intc_1');
  });

  it('strips oauthTokens and webhookSecret from the response', async () => {
    const rows = [
      { id: 'intc_1', provider: 'attio', oauthTokens: { accessToken: 'sec' }, webhookSecret: 'whsec' },
    ];
    const { request } = createTestApp('/api/integrations', integrationsRoutes, {
      context: { tenantDb: listDb(rows), permissions: permissions('integrations:read') },
    });

    const res = await request('/api/integrations/connections');
    const body = (await res.json()) as { data: Array<Record<string, unknown>> };
    expect(body.data[0].oauthTokens).toBeUndefined();
    expect(body.data[0].webhookSecret).toBeUndefined();
  });

  it('is denied without integrations:read', async () => {
    const { request } = createTestApp('/api/integrations', integrationsRoutes, {
      context: { tenantDb: listDb([]), permissions: permissions('companies:read') },
    });

    const res = await request('/api/integrations/connections');
    expect(res.status).toBe(403);
  });
});

describe('POST /api/integrations/connections/attio/authorize', () => {
  it('returns an Attio authorize URL WITHOUT a scope param', async () => {
    const { request } = createTestApp('/api/integrations', integrationsRoutes, {
      context: { permissions: permissions('integrations:create') },
      env: { ATTIO_CLIENT_ID: 'attio_client_test', WORKSPACE_CACHE: kvStub } as unknown as Partial<Env>,
    });

    const res = await request('/api/integrations/connections/attio/authorize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirectUri: 'https://app.weldsuite.org/settings/integrations/attio/callback' }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { authorizeUrl: string; state: string } };
    expect(body.data.authorizeUrl).toContain('https://app.attio.com/authorize');
    expect(body.data.authorizeUrl).toContain('client_id=attio_client_test');
    // Attio gotcha: scopes are configured on the OAuth app, NOT a query param.
    expect(body.data.authorizeUrl).not.toContain('scope=');
    expect(body.data.state).toBeTruthy();
  });

  it('fails cleanly when ATTIO_CLIENT_ID is not configured', async () => {
    const { request } = createTestApp('/api/integrations', integrationsRoutes, {
      context: { permissions: permissions('integrations:create') },
      env: { WORKSPACE_CACHE: kvStub } as unknown as Partial<Env>,
    });

    const res = await request('/api/integrations/connections/attio/authorize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirectUri: 'https://app.weldsuite.org/cb' }),
    });

    expect(res.status).toBe(500);
  });
});

describe('POST /api/integrations/connections/:provider/authorize', () => {
  it('rejects providers without a registered OAuth adapter', async () => {
    const { request } = createTestApp('/api/integrations', integrationsRoutes, {
      context: { permissions: permissions('integrations:create') },
      env: { WORKSPACE_CACHE: kvStub } as unknown as Partial<Env>,
    });

    const res = await request('/api/integrations/connections/salesforce/authorize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirectUri: 'https://app.weldsuite.org/cb' }),
    });

    expect(res.status).toBe(400);
  });

  it('rejects configured-adapter providers missing env credentials', async () => {
    const { request } = createTestApp('/api/integrations', integrationsRoutes, {
      context: { permissions: permissions('integrations:create') },
      env: { WORKSPACE_CACHE: kvStub } as unknown as Partial<Env>,
    });

    const res = await request('/api/integrations/connections/hubspot/authorize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirectUri: 'https://app.weldsuite.org/cb' }),
    });

    expect(res.status).toBe(400);
  });
});

describe('internal integrations router', () => {
  it('falls through when no internal headers are present', async () => {
    const { request } = createTestApp('/api/integrations', integrationsInternalRoutes, {
      env: { INTERNAL_API_SECRET: 'topsecret' } as unknown as Partial<Env>,
    });

    // Nothing else is mounted, so a fall-through surfaces as 404 (in the real
    // worker it proceeds to the Clerk-authed router mounted after the guard).
    const res = await request('/api/integrations/connections/intc_1/sync', { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('rejects an incorrect internal secret', async () => {
    const { request } = createTestApp('/api/integrations', integrationsInternalRoutes, {
      env: { INTERNAL_API_SECRET: 'topsecret' } as unknown as Partial<Env>,
    });

    const res = await request('/api/integrations/connections/intc_1/sync', {
      method: 'POST',
      headers: { 'X-Internal-Secret': 'wrong', 'X-Workspace-Id': 'org_123' },
    });
    expect(res.status).toBe(401);
  });

  it('rejects internal calls when INTERNAL_API_SECRET is unset', async () => {
    const { request } = createTestApp('/api/integrations', integrationsInternalRoutes, {});

    const res = await request('/api/integrations/connections/intc_1/sync', {
      method: 'POST',
      headers: { 'X-Internal-Secret': '', 'X-Workspace-Id': 'org_123' },
    });
    expect(res.status).toBe(401);
  });

  it('requires a workspace header once the secret checks out', async () => {
    const { request } = createTestApp('/api/integrations', integrationsInternalRoutes, {
      env: { INTERNAL_API_SECRET: 'topsecret' } as unknown as Partial<Env>,
    });

    const res = await request('/api/integrations/connections/intc_1/renew-watch', {
      method: 'POST',
      headers: { 'X-Internal-Secret': 'topsecret' },
    });
    expect(res.status).toBe(400);
  });
});
