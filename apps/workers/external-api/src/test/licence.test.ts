/**
 * The public API's app licence gate: a licensed (partner-managed) workspace
 * reaches only the modules its apps read; an unrestricted workspace (null)
 * reaches everything. Runs the real licenceMiddleware via the harness.
 */

import { describe, it, expect, vi } from 'vitest';
import { createExternalTestApp } from './harness';
import { isReadOnlyRequestAllowed, workspaceReadOnlyBody, workspaceRestrictions } from '../middleware/licence';
import type { ApiKeySession } from '../types';

const session = (licensedApps: readonly string[] | null, extra: Partial<ApiKeySession> = {}): ApiKeySession => ({
  keyId: 'key_test',
  keyType: 'personal',
  workspaceId: 'ws_test',
  userId: 'user_test',
  scopes: ['*'],
  tier: 'enterprise',
  hasApiAccess: true,
  databaseUrl: null,
  licensedApps,
  ...extra,
});

describe('external-api · licence gate', () => {
  it('rejects a module the workspace is not licensed for', async () => {
    const { request } = createExternalTestApp({ session: session(['welddesk']) });
    const res = await request('/v1/invoices');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: {
        code: 'APP_NOT_LICENSED',
        message: 'This workspace is not licensed for weldbooks.',
        details: { app: 'weldbooks' },
      },
    });
  });

  it('maps renamed objects onto their module', async () => {
    const { request } = createExternalTestApp({ session: session(['welddesk']) });
    expect((await request('/v1/knowledge-pages')).status).toBe(403);
    expect((await request('/v1/quotes')).status).not.toBe(403);
  });

  it('lets licensed and unrestricted workspaces through to the route', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const licensedApps of [['welddesk'], null]) {
      const { request } = createExternalTestApp({ session: session(licensedApps) });
      // The route then hits the (throwing) default tenant DB: anything but the
      // gate's 403 proves the request got past it.
      const res = await request('/v1/tickets');
      expect(res.status).not.toBe(403);
    }
    consoleError.mockRestore();
  });
});

describe('external-api · read-only workspaces', () => {
  const readOnly = (reason: 'partner_suspended' | 'licence_inactive' = 'partner_suspended') =>
    session(['welddesk'], { readOnly: true, readOnlyReason: reason });

  it('refuses writes with 403 WORKSPACE_READ_ONLY and the reason', async () => {
    const { request } = createExternalTestApp({ session: readOnly() });
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await request('/v1/tickets/t_1', { method });
      expect(res.status, method).toBe(403);
      expect(await res.json()).toMatchObject({
        error: { code: 'WORKSPACE_READ_ONLY', details: { reason: 'partner_suspended' } },
      });
    }
    const { request: inactive } = createExternalTestApp({ session: readOnly('licence_inactive') });
    const res = await inactive('/v1/tickets', { method: 'POST' });
    expect(await res.json()).toMatchObject({ error: { details: { reason: 'licence_inactive' } } });
  });

  it('lets reads and export POSTs past the gate', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { request } = createExternalTestApp({ session: readOnly() });
    expect((await request('/v1/tickets')).status).not.toBe(403);
    expect((await request('/v1/tickets/export', { method: 'POST' })).status).not.toBe(403);
    consoleError.mockRestore();
  });

  it('checks the app licence before read-only', async () => {
    const { request } = createExternalTestApp({ session: readOnly() });
    const res = await request('/v1/invoices', { method: 'POST' });
    expect(await res.json()).toMatchObject({ error: { code: 'APP_NOT_LICENSED' } });
  });

  it('does not touch writable sessions', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { request } = createExternalTestApp({ session: session(['welddesk'], { readOnly: false }) });
    expect((await request('/v1/tickets', { method: 'POST' })).status).not.toBe(403);
    consoleError.mockRestore();
  });
});

// The same rules as worker-kit's read-only.ts (this worker keeps a copy).
describe('external-api · workspaceRestrictions', () => {
  const base = { billingMode: 'partner', licenceStatus: 'active', licenceApps: ['welddesk'], partnerStatus: 'active' };

  it('is unrestricted for direct workspaces', () => {
    expect(workspaceRestrictions({ ...base, billingMode: 'direct', partnerStatus: 'suspended' })).toEqual({
      licensedApps: null,
      readOnly: false,
      readOnlyReason: null,
    });
  });

  it('licenses a partner workspace for its apps', () => {
    expect(workspaceRestrictions(base)).toEqual({ licensedApps: ['welddesk'], readOnly: false, readOnlyReason: null });
    expect(workspaceRestrictions({ ...base, partnerStatus: 'past_due' }).readOnly).toBe(false);
  });

  it('is read-only for a suspended partner or a non-active licence', () => {
    expect(workspaceRestrictions({ ...base, partnerStatus: 'suspended' })).toMatchObject({
      readOnly: true,
      readOnlyReason: 'partner_suspended',
    });
    for (const licenceStatus of ['suspended', 'ended']) {
      expect(workspaceRestrictions({ ...base, licenceStatus })).toMatchObject({
        readOnly: true,
        readOnlyReason: 'licence_inactive',
      });
    }
  });

  it('is core-only and read-only without a licence row', () => {
    expect(workspaceRestrictions({ ...base, licenceStatus: null, licenceApps: null })).toEqual({
      licensedApps: [],
      readOnly: true,
      readOnlyReason: 'licence_inactive',
    });
  });
});

describe('external-api · isReadOnlyRequestAllowed', () => {
  it('allows reads, exports and search; refuses other writes', () => {
    expect(isReadOnlyRequestAllowed('GET', '/v1/tickets')).toBe(true);
    expect(isReadOnlyRequestAllowed('HEAD', '/v1/tickets')).toBe(true);
    expect(isReadOnlyRequestAllowed('POST', '/v1/tickets/export')).toBe(true);
    expect(isReadOnlyRequestAllowed('POST', '/v1/search')).toBe(true);
    expect(isReadOnlyRequestAllowed('POST', '/v1/search-things')).toBe(false);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(isReadOnlyRequestAllowed(method, '/v1/tickets/t_1'), method).toBe(false);
    }
  });

  it('has the WORKSPACE_READ_ONLY body shape', () => {
    expect(workspaceReadOnlyBody('partner_suspended').error).toMatchObject({
      code: 'WORKSPACE_READ_ONLY',
      details: { reason: 'partner_suspended' },
    });
    expect(workspaceReadOnlyBody(null).error.details).toEqual({ reason: 'licence_inactive' });
  });
});
