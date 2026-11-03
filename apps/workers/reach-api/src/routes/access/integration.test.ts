/**
 * GET /api/reach/access: status, merged limits, live usage and the kill switch.
 * Also covers the app-access gate itself in front of these routes (not
 * approved -> 403 APP_ACCESS_REQUIRED, from @weldsuite/worker-kit).
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { appAccessGate } from '@weldsuite/worker-kit';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { WELDREACH_DEFAULT_LIMITS } from '@weldsuite/app-api-client/schemas/reach';
import { resetReachTenant, seedMailbox, seedReachDomain } from '../../lib/mailpool/testing-db';
import { approvedAccess } from '../../lib/mailpool/testing-routes';
import { default as accessRoutes } from './index';

let db: Database;

function api(options: { keys?: string[]; access?: ReturnType<typeof approvedAccess>; flags?: { isOn: () => Promise<boolean> } } = {}) {
  return createTestApp('/api/reach/access', accessRoutes, {
    context: {
      appAccess: options.access ?? approvedAccess(),
      permissions: permissions(...(options.keys ?? ['reach_campaigns:read'])),
      tenantDb: db,
      flags: options.flags as never,
    },
  }).request;
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 120_000);

beforeEach(async () => {
  await resetReachTenant(db);
});

describe('GET /api/reach/access', () => {
  it('returns defaults and zero usage for a fresh approved workspace', async () => {
    const res = await api()('/api/reach/access');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: {
        status: 'approved',
        limits: WELDREACH_DEFAULT_LIMITS,
        usage: { domains: 0, mailboxes: 0, sendsToday: 0 },
        sendingEnabled: true,
      },
    });
  });

  it('merges the staff-set limits over the defaults', async () => {
    const res = await api({ access: approvedAccess({ limits: { maxMailboxes: 25, allowConsumerRecipients: true, bogus: 1 } }) })('/api/reach/access');
    const { data } = (await res.json()) as { data: { limits: Record<string, unknown> } };
    expect(data.limits).toEqual({ ...WELDREACH_DEFAULT_LIMITS, maxMailboxes: 25, allowConsumerRecipients: true });
  });

  it('counts domains, existing mailboxes, and outbound sends since 00:00 UTC', async () => {
    await seedReachDomain(db, { id: 'rdom_1', hostDomainId: 'dom_1', name: 'getacme.com' });
    await seedMailbox(db, { id: 'rmbx_1', domainId: 'rdom_1' });
    await seedMailbox(db, { id: 'rmbx_2', domainId: 'rdom_1', status: 'warming' });
    await seedMailbox(db, { id: 'rmbx_3', domainId: 'rdom_1', status: 'deleted', deletedAt: new Date() });

    const midnight = new Date();
    midnight.setUTCHours(0, 0, 0, 0);
    const base = { mailboxId: 'rmbx_1', fromEmail: 'a@getacme.com', toEmail: 'b@x.com' };
    await db.insert(schema.reachMessages).values([
      { id: 'rmsg_1', direction: 'out', messageIdHeader: '<1@a>', status: 'sent', sentAt: new Date(midnight.getTime() + 1000), ...base },
      { id: 'rmsg_2', direction: 'out', messageIdHeader: '<2@a>', status: 'sent', sentAt: new Date(midnight.getTime() - 1000), ...base },
      { id: 'rmsg_3', direction: 'out', messageIdHeader: '<3@a>', status: 'failed', sentAt: new Date(midnight.getTime() + 2000), ...base },
      { id: 'rmsg_4', direction: 'in', messageIdHeader: '<4@a>', kind: 'reply', receivedAt: new Date(midnight.getTime() + 3000), ...base },
    ]);

    const { data } = (await (await api()('/api/reach/access')).json()) as { data: { usage: unknown } };
    expect(data.usage).toEqual({ domains: 1, mailboxes: 2, sendsToday: 1 });
  });

  it('reports the Flagship kill switch', async () => {
    const off = (await (await api({ flags: { isOn: async () => false } })('/api/reach/access')).json()) as { data: { sendingEnabled: boolean } };
    expect(off.data.sendingEnabled).toBe(false);
  });

  it('is open to any WeldReach read permission, and closed to everyone else', async () => {
    for (const key of ['reach_campaigns:read', 'reach_prospects:read', 'reach_inbox:read', 'reach_mailboxes:read', 'reach_settings:read']) {
      expect((await api({ keys: [key] })('/api/reach/access')).status, key).toBe(200);
    }
    expect((await api({ keys: ['leads:read'] })('/api/reach/access')).status).toBe(403);
  });
});

describe('appAccessGate in front of /api/reach', () => {
  const env = { ENVIRONMENT: 'test' };

  /** The real gate with a KV that holds the access cache entry. */
  function gated(status: string) {
    const kv = {
      get: async () => ({ workspaceId: 'ws_acme', status, limits: {}, billingStatus: 'none', billingStatusAt: null }),
      put: async () => {},
    };
    const app = new Hono<{ Variables: { orgId: string } }>();
    app.use('*', async (c, next) => {
      c.set('orgId', 'org_acme');
      await next();
    });
    app.use('/api/reach/*', appAccessGate('weldreach') as never);
    app.get('/api/reach/ping', (c) => c.json({ ok: true }));
    return (path: string) => app.request(path, undefined, { ...env, WORKSPACE_CACHE: kv } as never);
  }

  it.each(['requested', 'rejected', 'suspended', 'revoked', 'none'])('refuses a workspace whose access is %s with 403 APP_ACCESS_REQUIRED', async (status) => {
    const res = await gated(status)('/api/reach/ping');
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: 'APP_ACCESS_REQUIRED', details: { appCode: 'weldreach', status } } });
  });

  it('lets an approved workspace through', async () => {
    expect((await gated('approved')('/api/reach/ping')).status).toBe(200);
  });
});
