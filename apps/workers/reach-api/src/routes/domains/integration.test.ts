/**
 * /api/reach/domains over HTTP: the connect guards as the client experiences
 * them (a name from the client is ignored, another workspace's domain is a 404,
 * MX / website block), limits, events and disconnect. DNS goes through a
 * DNS-over-HTTPS stub on the global fetch.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { masterSchema, schema, type Database, type MasterDatabase } from '@weldsuite/worker-kit/db';
import { MailpoolError } from '../../lib/mailpool/errors';
import { createFakeMailpool, type FakeMailpool } from '../../lib/mailpool/testing';
import { resetReachMaster, resetReachTenant, seedHostDomain, seedMailbox, seedReachDomain } from '../../lib/mailpool/testing-db';
import { approvedAccess, dohResponse, withAppAccess } from '../../lib/mailpool/testing-routes';

vi.mock('@weldsuite/entity-events', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/entity-events')>('@weldsuite/entity-events');
  return { ...actual, publishEntityEvent: vi.fn() };
});
import { publishEntityEvent } from '@weldsuite/entity-events';
const published = publishEntityEvent as unknown as ReturnType<typeof vi.fn>;

let masterDb: MasterDatabase;
vi.mock('@weldsuite/worker-kit/db', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/worker-kit/db')>('@weldsuite/worker-kit/db');
  return { ...actual, getMasterDb: () => masterDb };
});

let mailpool: FakeMailpool;
vi.mock('../../lib/mailpool/client', async () => {
  const actual = await vi.importActual<typeof import('../../lib/mailpool/client')>('../../lib/mailpool/client');
  return { ...actual, createMailpoolClient: () => mailpool };
});

// Imported AFTER the mocks above are registered.
const { default: domainRoutes } = await import('./index');

let db: Database;

/** DNS records the stubbed resolver knows: `"<name>|<TYPE>"` -> values. */
let zone: Record<string, string[]> = {};

const ALL = ['reach_mailboxes:read', 'reach_mailboxes:create', 'reach_mailboxes:update', 'reach_mailboxes:delete'];

function api(keys: string[] = ALL, access = approvedAccess()) {
  return createTestApp('/api/reach/domains', withAppAccess(domainRoutes, access), {
    context: { permissions: permissions(...keys), tenantDb: db, workspaceId: 'org_acme' },
  }).request;
}
const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  masterDb = (await createMasterPgliteDb()).db as MasterDatabase;
}, 120_000);

beforeEach(async () => {
  published.mockClear();
  mailpool = createFakeMailpool();
  zone = {};
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const name = url.searchParams.get('name') ?? '';
      const type = url.searchParams.get('type') ?? '';
      return dohResponse(name, type, zone[`${name}|${type}`] ?? []);
    }),
  );
  await resetReachTenant(db);
  await resetReachMaster(masterDb);
  await seedHostDomain(db, { id: 'dom_ok', fullDomain: 'getacme.com' });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('permissions', () => {
  it.each([
    ['GET /', 'GET', '', undefined, 'reach_mailboxes:read'],
    ['GET /candidates', 'GET', '/candidates', undefined, 'reach_mailboxes:read'],
    ['GET /:id', 'GET', '/rdom_1', undefined, 'reach_mailboxes:read'],
    ['POST /', 'POST', '', { hostDomainId: 'dom_ok' }, 'reach_mailboxes:create'],
    ['POST /:id/refresh-dns', 'POST', '/rdom_1/refresh-dns', {}, 'reach_mailboxes:update'],
    ['DELETE /:id', 'DELETE', '/rdom_1', undefined, 'reach_mailboxes:delete'],
  ])('%s needs %s', async (_label, method, path, body, needed) => {
    const res = await api(ALL.filter((k) => k !== needed))(`/api/reach/domains${path}`, json(method, body));
    expect(res.status).toBe(403);
    expect(mailpool.connectCloudflareDomains).not.toHaveBeenCalled();
  });
});

describe('GET /candidates', () => {
  it('lists this workspace\'s WeldHost domains with eligibility', async () => {
    await seedHostDomain(db, { id: 'dom_mx', fullDomain: 'mail.com' });
    zone['mail.com|MX'] = ['aspmx.l.google.com'];

    const res = await api(['reach_mailboxes:read'])('/api/reach/domains/candidates');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ name: string; eligible: boolean; reason: string | null }>; pagination: { totalCount: number } };

    expect(body.pagination.totalCount).toBe(2);
    expect(body.data).toEqual([
      { hostDomainId: 'dom_ok', name: 'getacme.com', hostStatus: 'active', eligible: true, reason: null },
      { hostDomainId: 'dom_mx', name: 'mail.com', hostStatus: 'active', eligible: false, reason: 'has_mx' },
    ]);
  });
});

describe('POST /', () => {
  it('connects a WeldHost domain: 201, an event, a route for this workspace', async () => {
    const res = await api()('/api/reach/domains', json('POST', { hostDomainId: 'dom_ok' }));

    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: Record<string, unknown> };
    expect(data).toMatchObject({
      hostDomainId: 'dom_ok',
      name: 'getacme.com',
      status: 'active',
      mailpoolDomainId: '5000',
      mailboxCount: 0,
      dnsStatus: null,
    });
    expect(data).not.toHaveProperty('forcedBy');
    expect(published.mock.calls[0]![0]).toMatchObject({ entityType: 'reach_domain', action: 'connected', entityId: data.id });

    const [route] = await masterDb.select().from(masterSchema.reachRoutes);
    expect(route).toMatchObject({ kind: 'mailpool_domain', workspaceId: 'ws_acme', clerkOrgId: 'org_acme', externalId: '5000' });
  });

  it('ignores a domain name sent by the client: only hostDomainId counts, and it must belong to this tenant', async () => {
    const res = await api()('/api/reach/domains', json('POST', { hostDomainId: 'dom_of_another_workspace', name: 'victim.com', domain: 'victim.com' }));

    expect(res.status).toBe(404);
    expect(mailpool.connectCloudflareDomains).not.toHaveBeenCalled();
    expect(await db.select().from(schema.reachDomains)).toHaveLength(0);
    expect(published).not.toHaveBeenCalled();

    // Sending a name along with a valid id does not change what is connected.
    await api()('/api/reach/domains', json('POST', { hostDomainId: 'dom_ok', name: 'victim.com' }));
    expect(mailpool.connectCloudflareDomains).toHaveBeenCalledExactlyOnceWith(['getacme.com']);
  });

  it('answers 422 DOMAIN_NOT_ELIGIBLE with the reason for MX records and for a website', async () => {
    zone['getacme.com|MX'] = ['mx.old-host.com'];
    const mx = await api()('/api/reach/domains', json('POST', { hostDomainId: 'dom_ok' }));
    expect(mx.status).toBe(422);
    expect(await mx.json()).toMatchObject({ error: { code: 'DOMAIN_NOT_ELIGIBLE', details: { reason: 'has_mx' } } });

    zone = { 'www.getacme.com|A': ['203.0.113.5'] };
    const web = await api()('/api/reach/domains', json('POST', { hostDomainId: 'dom_ok' }));
    expect(await web.json()).toMatchObject({ error: { code: 'DOMAIN_NOT_ELIGIBLE', details: { reason: 'has_website' } } });
    expect(mailpool.connectCloudflareDomains).not.toHaveBeenCalled();
  });

  it('lets staff force a domain through despite MX and website', async () => {
    zone['getacme.com|MX'] = ['mx.old-host.com'];
    zone['getacme.com|A'] = ['203.0.113.5'];
    const res = await api(ALL, approvedAccess({ limits: { forceAllowDomains: ['getacme.com'] } }))('/api/reach/domains', json('POST', { hostDomainId: 'dom_ok' }));
    expect(res.status).toBe(201);
  });

  it('answers 422 limit_reached at the staff-set domain limit and 409 for a repeat connect', async () => {
    await seedHostDomain(db, { id: 'dom_two', fullDomain: 'second.com' });
    const limited = approvedAccess({ limits: { maxDomains: 1 } });
    expect((await api(ALL, limited)('/api/reach/domains', json('POST', { hostDomainId: 'dom_ok' }))).status).toBe(201);

    const over = await api(ALL, limited)('/api/reach/domains', json('POST', { hostDomainId: 'dom_two' }));
    expect(over.status).toBe(422);
    expect(await over.json()).toMatchObject({ error: { details: { reason: 'limit_reached' } } });

    const again = await api(ALL, limited)('/api/reach/domains', json('POST', { hostDomainId: 'dom_ok' }));
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: { code: 'DOMAIN_ALREADY_CONNECTED' } });
  });

  it('answers 503 when DNS cannot be checked, and 400 for a bad body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad gateway', { status: 502 })));
    const res = await api()('/api/reach/domains', json('POST', { hostDomainId: 'dom_ok' }));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: 'DNS_CHECK_FAILED' } });
    expect(mailpool.connectCloudflareDomains).not.toHaveBeenCalled();

    expect((await api()('/api/reach/domains', json('POST', {}))).status).toBe(400);
  });

  it('answers 502 when Mailpool fails and stores nothing', async () => {
    mailpool.connectCloudflareDomains.mockRejectedValueOnce(new MailpoolError({ method: 'POST', path: '/domains/cloudflare/connect', status: 500 }));
    const res = await api()('/api/reach/domains', json('POST', { hostDomainId: 'dom_ok' }));
    expect(res.status).toBe(502);
    expect(await db.select().from(schema.reachDomains)).toHaveLength(0);
    expect(published).not.toHaveBeenCalled();
  });
});

describe('reads and refresh', () => {
  it('lists and gets connected domains with their mailbox count', async () => {
    await seedReachDomain(db, { id: 'rdom_1', hostDomainId: 'dom_ok', name: 'getacme.com' });
    await seedMailbox(db, { id: 'rmbx_1', domainId: 'rdom_1' });

    const list = (await (await api(['reach_mailboxes:read'])('/api/reach/domains')).json()) as { data: Array<{ id: string; mailboxCount: number }> };
    expect(list.data).toEqual([expect.objectContaining({ id: 'rdom_1', mailboxCount: 1 })]);

    expect((await api(['reach_mailboxes:read'])('/api/reach/domains/rdom_1')).status).toBe(200);
    expect((await api(['reach_mailboxes:read'])('/api/reach/domains/rdom_missing')).status).toBe(404);
  });

  it('POST /:id/refresh-dns stores the DNS status and publishes reach_domain:updated', async () => {
    await seedReachDomain(db, { id: 'rdom_1', hostDomainId: 'dom_ok', name: 'getacme.com', mailpoolDomainId: '5001' });
    mailpool.getDomainDns.mockResolvedValueOnce([{ type: 'MX', key: '@', priority: 1, value: 'smtp.google.com' }]);
    zone['getacme.com|MX'] = ['smtp.google.com'];

    const res = await api()('/api/reach/domains/rdom_1/refresh-dns', json('POST', {}));

    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { dnsStatus: { mx: boolean; spf: boolean } } };
    expect(data.dnsStatus).toMatchObject({ mx: true, spf: false });
    expect(published.mock.calls[0]![0]).toMatchObject({ entityType: 'reach_domain', action: 'updated', entityId: 'rdom_1' });
  });
});

describe('DELETE /:id', () => {
  it('answers 409 DOMAIN_HAS_MAILBOXES while mailboxes remain', async () => {
    await seedReachDomain(db, { id: 'rdom_1', hostDomainId: 'dom_ok', name: 'getacme.com' });
    await seedMailbox(db, { id: 'rmbx_1', domainId: 'rdom_1' });

    const res = await api()('/api/reach/domains/rdom_1', { method: 'DELETE' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: 'DOMAIN_HAS_MAILBOXES' } });
    expect(mailpool.deleteDomain).not.toHaveBeenCalled();
    expect(published).not.toHaveBeenCalled();
  });

  it('disconnects: 204, Mailpool delete, reach_domain:disconnected, the WeldHost domain stays', async () => {
    await seedReachDomain(db, { id: 'rdom_1', hostDomainId: 'dom_ok', name: 'getacme.com', mailpoolDomainId: '5001' });

    const res = await api()('/api/reach/domains/rdom_1', { method: 'DELETE' });

    expect(res.status).toBe(204);
    expect(mailpool.deleteDomain).toHaveBeenCalledWith('5001');
    expect(published.mock.calls[0]![0]).toMatchObject({ entityType: 'reach_domain', action: 'disconnected', entityId: 'rdom_1' });
    expect(await db.select().from(schema.reachDomains)).toHaveLength(0);
    expect(await db.select().from(schema.hostDomains)).toHaveLength(1);
  });
});
