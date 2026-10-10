/**
 * The public API's app licence gate: a licensed (partner-managed) workspace
 * reaches only the modules its apps read; an unrestricted workspace (null)
 * reaches everything. Runs the real licenceMiddleware via the harness.
 */

import { describe, it, expect, vi } from 'vitest';
import { createExternalTestApp } from './harness';
import type { ApiKeySession } from '../types';

const session = (licensedApps: readonly string[] | null): ApiKeySession => ({
  keyId: 'key_test',
  keyType: 'personal',
  workspaceId: 'ws_test',
  userId: 'user_test',
  scopes: ['*'],
  tier: 'enterprise',
  hasApiAccess: true,
  databaseUrl: null,
  licensedApps,
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
