/**
 * Domain connect guards and lifecycle, against pglite (tenant + master) with a
 * fake Mailpool and a static resolver.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { masterSchema, schema, type Database, type MasterDatabase } from '@weldsuite/worker-kit/db';
import type { DnsRecord, DnsRecordType } from '@weldsuite/worker-kit/dns-lookup';
import { WELDREACH_DEFAULT_LIMITS, type WeldReachLimits } from '@weldsuite/app-api-client/schemas/reach';
import type { DnsLookup } from '../lib/dns';
import { MailpoolError } from '../lib/mailpool/errors';
import { createFakeMailpool, type FakeMailpool } from '../lib/mailpool/testing';
import { resetReachMaster, resetReachTenant, seedHostDomain, seedMailbox, seedReachDomain } from '../lib/mailpool/testing-db';
import {
  connectDomain,
  disconnectDomain,
  listCandidates,
  listDomains,
  refreshDomainDns,
  type DomainDeps,
} from './domains';
import { ReachServiceError } from './reach-errors';

let db: Database;
let master: MasterDatabase;

/** Static resolver: `"<name>|<TYPE>"` -> values. */
function resolver(zone: Record<string, string[]> = {}): DnsLookup {
  return async (name: string, type: DnsRecordType) =>
    (zone[`${name}|${type}`] ?? []).map((value): DnsRecord => ({ name, type, value, ttl: 300 }));
}

function deps(overrides: Omit<Partial<DomainDeps>, 'limits'> & { limits?: Partial<WeldReachLimits> } = {}) {
  const { limits, ...rest } = overrides;
  const mailpool = createFakeMailpool();
  return {
    mailpool,
    deps: {
      db,
      master,
      mailpool,
      clerkOrgId: 'org_acme',
      masterWorkspaceId: 'ws_acme',
      userId: 'user_1',
      limits: { ...WELDREACH_DEFAULT_LIMITS, ...limits },
      lookup: resolver(),
      now: () => new Date('2026-10-12T10:00:00Z'),
      ...rest,
    } satisfies DomainDeps,
  };
}

async function reason(promise: Promise<unknown>): Promise<unknown> {
  const err = (await promise.then(
    () => null,
    (e: unknown) => e,
  )) as ReachServiceError | null;
  expect(err).toBeInstanceOf(ReachServiceError);
  return (err?.details as { reason?: string } | undefined)?.reason ?? err?.code;
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  master = (await createMasterPgliteDb()).db as MasterDatabase;
}, 120_000);

beforeEach(async () => {
  await resetReachTenant(db);
  await resetReachMaster(master);
});

describe('candidates', () => {
  it('lists only this workspace\'s WeldHost domains, each with its first failing guard', async () => {
    await seedHostDomain(db, { id: 'dom_ok', fullDomain: 'getacme.com' });
    await seedHostDomain(db, { id: 'dom_pending', fullDomain: 'pending.com', status: 'pending' });
    await seedHostDomain(db, { id: 'dom_hetzner', fullDomain: 'legacy.com', zoneProvider: 'hetzner' });
    await seedHostDomain(db, { id: 'dom_mx', fullDomain: 'mail.com' });
    await seedHostDomain(db, { id: 'dom_web', fullDomain: 'site.com' });
    await seedHostDomain(db, { id: 'dom_conn', fullDomain: 'used.com' });
    await seedReachDomain(db, { id: 'rdom_1', hostDomainId: 'dom_conn', name: 'used.com' });

    const lookup = resolver({ 'mail.com|MX': ['aspmx.l.google.com'], 'site.com|A': ['203.0.113.1'] });
    const { deps: d } = deps({ lookup, limits: { maxDomains: 10 } });
    const byName = new Map((await listCandidates(d)).map((c) => [c.name, c]));

    expect(byName.get('getacme.com')).toMatchObject({ eligible: true, reason: null, hostDomainId: 'dom_ok' });
    expect(byName.get('pending.com')).toMatchObject({ eligible: false, reason: 'not_active' });
    expect(byName.get('legacy.com')).toMatchObject({ eligible: false, reason: 'not_on_cloudflare' });
    expect(byName.get('mail.com')).toMatchObject({ eligible: false, reason: 'has_mx' });
    expect(byName.get('site.com')).toMatchObject({ eligible: false, reason: 'has_website' });
    expect(byName.get('used.com')).toMatchObject({ eligible: false, reason: 'already_connected' });
    expect(byName.size).toBe(6);
  });

  it('marks everything not yet connected as limit_reached once maxDomains are connected', async () => {
    await seedHostDomain(db, { id: 'dom_a', fullDomain: 'a.com' });
    await seedHostDomain(db, { id: 'dom_b', fullDomain: 'b.com' });
    await seedReachDomain(db, { id: 'rdom_a', hostDomainId: 'dom_a', name: 'a.com' });

    const { deps: d } = deps({ limits: { maxDomains: 1 } });
    const byName = new Map((await listCandidates(d)).map((c) => [c.name, c]));
    expect(byName.get('b.com')).toMatchObject({ eligible: false, reason: 'limit_reached' });
  });

  it('skips the MX / website checks for domains staff force-allowed', async () => {
    await seedHostDomain(db, { id: 'dom_f', fullDomain: 'forced.com' });
    const lookup = resolver({ 'forced.com|MX': ['mx.old.com'], 'forced.com|A': ['203.0.113.1'] });

    const blocked = await listCandidates(deps({ lookup }).deps);
    expect(blocked[0]).toMatchObject({ eligible: false, reason: 'has_mx' });

    const allowed = await listCandidates(deps({ lookup, limits: { forceAllowDomains: ['forced.com'] } }).deps);
    expect(allowed[0]).toMatchObject({ eligible: true, reason: null });
  });

  it('does not hide a domain because the resolver hiccuped (the connect re-checks)', async () => {
    await seedHostDomain(db, { id: 'dom_ok', fullDomain: 'getacme.com' });
    const broken: DnsLookup = async () => {
      throw new Error('resolver down');
    };
    expect((await listCandidates(deps({ lookup: broken }).deps))[0]).toMatchObject({ eligible: true });
  });

  it('counts a registrar-cloudflare or nameserver-verified domain as on Cloudflare even without a zone row', async () => {
    await seedHostDomain(db, { id: 'dom_r', fullDomain: 'reg.com', zoneProvider: null, registrar: 'cloudflare' });
    await seedHostDomain(db, { id: 'dom_n', fullDomain: 'ns.com', zoneProvider: null, nameserverVerified: true });
    const result = await listCandidates(deps().deps);
    expect(result.every((c) => c.eligible)).toBe(true);
  });
});

describe('connectDomain', () => {
  it('connects through Mailpool, stores the domain and routes it to this workspace', async () => {
    await seedHostDomain(db, { id: 'dom_ok', fullDomain: 'GetAcme.com' });
    const { deps: d, mailpool } = deps();

    const row = await connectDomain(d, 'dom_ok');

    expect(mailpool.connectCloudflareDomains).toHaveBeenCalledWith(['getacme.com']);
    expect(row).toMatchObject({
      hostDomainId: 'dom_ok',
      name: 'getacme.com',
      mailpoolDomainId: '5000',
      status: 'active',
      connectedBy: 'user_1',
      forcedBy: null,
    });
    expect(row.id).toMatch(/^rdom_/);

    const [route] = await master.select().from(masterSchema.reachRoutes).where(eq(masterSchema.reachRoutes.externalId, '5000'));
    expect(route).toMatchObject({
      kind: 'mailpool_domain',
      workspaceId: 'ws_acme',
      clerkOrgId: 'org_acme',
      tenantEntityId: row.id,
      status: 'active',
    });
    expect(await listDomains(db)).toHaveLength(1);
  });

  it('never trusts a domain from the client: only a hostDomainId of this tenant resolves', async () => {
    await seedHostDomain(db, { id: 'dom_mine', fullDomain: 'mine.com' });
    const { deps: d, mailpool } = deps();

    // Another workspace's WeldHost domain id (or a made-up one) is not in this tenant's `domains`.
    expect(await reason(connectDomain(d, 'dom_other_workspace'))).toBe('DOMAIN_NOT_FOUND');
    // A name is not an id.
    expect(await reason(connectDomain(d, 'victim.com'))).toBe('DOMAIN_NOT_FOUND');
    expect(mailpool.connectCloudflareDomains).not.toHaveBeenCalled();
    expect(await listDomains(db)).toHaveLength(0);
  });

  it('blocks a deleted WeldHost domain', async () => {
    await seedHostDomain(db, { id: 'dom_gone', fullDomain: 'gone.com' });
    await db.update(schema.hostDomains).set({ deletedAt: new Date() }).where(eq(schema.hostDomains.id, 'dom_gone'));
    expect(await reason(connectDomain(deps().deps, 'dom_gone'))).toBe('DOMAIN_NOT_FOUND');
  });

  it.each([
    ['that is not active in WeldHost', { id: 'd1', fullDomain: 'a.com', status: 'pending' as const }, {}, 'not_active'],
    ['that is not on Cloudflare', { id: 'd2', fullDomain: 'b.com', zoneProvider: 'hetzner' as const }, {}, 'not_on_cloudflare'],
    ['carrying MX records', { id: 'd3', fullDomain: 'c.com' }, { 'c.com|MX': ['mx.old.com'] }, 'has_mx'],
    ['serving a website on the apex', { id: 'd4', fullDomain: 'd.com' }, { 'd.com|A': ['203.0.113.9'] }, 'has_website'],
    ['serving a website on www', { id: 'd5', fullDomain: 'e.com' }, { 'www.e.com|AAAA': ['2001:db8::1'] }, 'has_website'],
  ])('refuses a domain %s, without calling Mailpool', async (_label, host, zone, expected) => {
    await seedHostDomain(db, host);
    const { deps: d, mailpool } = deps({ lookup: resolver(zone) });

    expect(await reason(connectDomain(d, host.id))).toBe(expected);
    expect(mailpool.connectCloudflareDomains).not.toHaveBeenCalled();
    expect(await listDomains(db)).toHaveLength(0);
  });

  it('lets a staff force-allowed domain through despite MX records, and records that it was forced', async () => {
    await seedHostDomain(db, { id: 'dom_f', fullDomain: 'forced.com' });
    const { deps: d, mailpool } = deps({
      lookup: resolver({ 'forced.com|MX': ['mx.old.com'], 'forced.com|A': ['203.0.113.1'] }),
      limits: { forceAllowDomains: ['forced.com'] },
    });

    const row = await connectDomain(d, 'dom_f');
    expect(row.forcedBy).toBe('admin_console');
    expect(mailpool.connectCloudflareDomains).toHaveBeenCalledOnce();
  });

  it('refuses beyond maxDomains', async () => {
    await seedHostDomain(db, { id: 'dom_a', fullDomain: 'a.com' });
    await seedHostDomain(db, { id: 'dom_b', fullDomain: 'b.com' });
    const { deps: d } = deps({ limits: { maxDomains: 1 } });

    await connectDomain(d, 'dom_a');
    expect(await reason(connectDomain(d, 'dom_b'))).toBe('limit_reached');
  });

  it('refuses a domain that is already connected with 409', async () => {
    await seedHostDomain(db, { id: 'dom_a', fullDomain: 'a.com' });
    const { deps: d } = deps();
    await connectDomain(d, 'dom_a');

    const err = (await connectDomain(d, 'dom_a').catch((e: unknown) => e)) as ReachServiceError;
    expect(err.status).toBe(409);
    expect(err.code).toBe('DOMAIN_ALREADY_CONNECTED');
  });

  it('fails closed when DNS cannot be checked', async () => {
    await seedHostDomain(db, { id: 'dom_a', fullDomain: 'a.com' });
    const broken: DnsLookup = async () => {
      throw new Error('resolver down');
    };
    const { deps: d, mailpool } = deps({ lookup: broken });

    await expect(connectDomain(d, 'dom_a')).rejects.toMatchObject({ name: 'DnsLookupError' });
    expect(mailpool.connectCloudflareDomains).not.toHaveBeenCalled();
  });

  it('reports a domain Mailpool skipped and stores nothing', async () => {
    await seedHostDomain(db, { id: 'dom_a', fullDomain: 'a.com' });
    const { deps: d, mailpool } = deps();
    mailpool.connectCloudflareDomains.mockResolvedValueOnce({ connected: [], skipped: [{ domain: 'a.com', reason: 'zone not found' }] });

    const err = (await connectDomain(d, 'dom_a').catch((e: unknown) => e)) as ReachServiceError;
    expect(err.code).toBe('DOMAIN_CONNECT_FAILED');
    expect(err.message).toContain('zone not found');
    expect(await listDomains(db)).toHaveLength(0);
  });

  it('stores a still-activating domain as connecting', async () => {
    await seedHostDomain(db, { id: 'dom_a', fullDomain: 'a.com' });
    const { deps: d, mailpool } = deps();
    mailpool.connectCloudflareDomains.mockResolvedValueOnce({ connected: [{ id: 42, domain: 'a.com', status: 'Pending' }], skipped: [] });

    expect((await connectDomain(d, 'dom_a')).status).toBe('connecting');
  });

  it('does not take over a Mailpool domain id that is routed to another workspace', async () => {
    await seedHostDomain(db, { id: 'dom_a', fullDomain: 'a.com' });
    await master.insert(masterSchema.reachRoutes).values({
      id: 'rrt_other',
      kind: 'mailpool_domain',
      externalId: '5000',
      workspaceId: 'ws_other',
      clerkOrgId: 'org_other',
      tenantEntityId: 'rdom_other',
      status: 'active',
    });
    const { deps: d, mailpool } = deps();

    await expect(connectDomain(d, 'dom_a')).rejects.toMatchObject({ code: 'DOMAIN_IN_USE' });
    // It is not ours to delete at Mailpool, and our row is gone again.
    expect(mailpool.deleteDomain).not.toHaveBeenCalled();
    expect(await listDomains(db)).toHaveLength(0);
    const [route] = await master.select().from(masterSchema.reachRoutes).where(eq(masterSchema.reachRoutes.externalId, '5000'));
    expect(route?.workspaceId).toBe('ws_other');
  });

  it('reuses its own earlier route when a disconnected domain is connected again', async () => {
    await seedHostDomain(db, { id: 'dom_a', fullDomain: 'a.com' });
    const { deps: d } = deps();
    const first = await connectDomain(d, 'dom_a');
    await disconnectDomain(d, first.id);

    const second = await connectDomain(d, 'dom_a');
    const routes = await master.select().from(masterSchema.reachRoutes).where(eq(masterSchema.reachRoutes.kind, 'mailpool_domain'));
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({ status: 'active', tenantEntityId: second.id });
  });
});

describe('refreshDomainDns', () => {
  it('stores DNS health, DMARC policy and Mailpool status', async () => {
    await seedHostDomain(db, { id: 'dom_a', fullDomain: 'a.com' });
    const { deps: d, mailpool } = deps();
    const row = await connectDomain(d, 'dom_a');
    // Mailpool writes the records after the connect.
    const afterConnect = resolver({
      'a.com|MX': ['smtp.google.com'],
      '_dmarc.a.com|TXT': ['v=DMARC1; p=quarantine'],
    });
    mailpool.getDomainDns.mockResolvedValueOnce([
      { type: 'MX', key: '@', priority: 1, value: 'smtp.google.com' },
      { type: 'TXT', key: '_dmarc', value: 'v=DMARC1; p=quarantine' },
    ]);

    const refreshed = await refreshDomainDns({ ...d, lookup: afterConnect }, row.id);

    expect(refreshed.dnsStatus).toMatchObject({ mx: true, dmarc: true, spf: false, dkim: false, checkedAt: '2026-10-12T10:00:00.000Z' });
    expect(refreshed.dmarcPolicy).toBe('quarantine');
    expect(refreshed.status).toBe('active');
  });

  it('turns a disabled domain into an error with the provider message', async () => {
    await seedHostDomain(db, { id: 'dom_a', fullDomain: 'a.com' });
    const { deps: d, mailpool } = deps();
    const row = await connectDomain(d, 'dom_a');
    mailpool.getDomain.mockResolvedValueOnce({ id: 5000, domain: 'a.com', status: 'inactive', error: { code: 102, message: 'Disabled due to spam abuse.' } });

    const refreshed = await refreshDomainDns(d, row.id);
    expect(refreshed).toMatchObject({ status: 'error', lastError: 'Disabled due to spam abuse.' });
  });

  it('keeps the stored status when DNS cannot be read', async () => {
    await seedHostDomain(db, { id: 'dom_a', fullDomain: 'a.com' });
    const { deps: d } = deps();
    const row = await connectDomain(d, 'dom_a');
    const broken: DnsLookup = async () => {
      throw new Error('resolver down');
    };

    await expect(refreshDomainDns({ ...d, lookup: broken }, row.id)).rejects.toMatchObject({ name: 'DnsLookupError' });
    const [stored] = await db.select().from(schema.reachDomains).where(eq(schema.reachDomains.id, row.id));
    expect(stored?.dnsStatus).toBeNull();
  });
});

describe('disconnectDomain', () => {
  it('refuses with 409 while the domain still has mailboxes', async () => {
    await seedHostDomain(db, { id: 'dom_a', fullDomain: 'a.com' });
    const { deps: d, mailpool } = deps();
    const row = await connectDomain(d, 'dom_a');
    await seedMailbox(db, { id: 'rmbx_1', domainId: row.id });

    const err = (await disconnectDomain(d, row.id).catch((e: unknown) => e)) as ReachServiceError;
    expect(err.status).toBe(409);
    expect(err.code).toBe('DOMAIN_HAS_MAILBOXES');
    expect(mailpool.deleteDomain).not.toHaveBeenCalled();
    expect(await listDomains(db)).toHaveLength(1);
  });

  it('ignores mailboxes that are already deleted', async () => {
    await seedHostDomain(db, { id: 'dom_a', fullDomain: 'a.com' });
    const { deps: d } = deps();
    const row = await connectDomain(d, 'dom_a');
    await seedMailbox(db, { id: 'rmbx_1', domainId: row.id, status: 'deleted', deletedAt: new Date() });

    await disconnectDomain(d, row.id);
    expect(await listDomains(db)).toHaveLength(0);
  });

  it('deletes at Mailpool, closes the route and removes the row (the WeldHost domain stays)', async () => {
    await seedHostDomain(db, { id: 'dom_a', fullDomain: 'a.com' });
    const { deps: d, mailpool } = deps();
    const row = await connectDomain(d, 'dom_a');

    await disconnectDomain(d, row.id);

    expect(mailpool.deleteDomain).toHaveBeenCalledWith('5000');
    expect(await listDomains(db)).toHaveLength(0);
    const [route] = await master
      .select()
      .from(masterSchema.reachRoutes)
      .where(and(eq(masterSchema.reachRoutes.kind, 'mailpool_domain'), eq(masterSchema.reachRoutes.externalId, '5000')));
    expect(route?.status).toBe('deleted');
    const [host] = await db.select().from(schema.hostDomains).where(eq(schema.hostDomains.id, 'dom_a'));
    expect(host?.status).toBe('active');
  });

  it('can be run again when an earlier attempt stopped half way', async () => {
    await seedHostDomain(db, { id: 'dom_a', fullDomain: 'a.com' });
    const { deps: d, mailpool } = deps();
    const row = await connectDomain(d, 'dom_a');
    await db.update(schema.reachDomains).set({ status: 'disconnecting' }).where(eq(schema.reachDomains.id, row.id));
    mailpool.deleteDomain.mockRejectedValueOnce(new MailpoolError({ method: 'DELETE', path: '/domains/5000', status: 404 }));

    await disconnectDomain(d, row.id);
    expect(await listDomains(db)).toHaveLength(0);
  });

  it('treats a domain Mailpool no longer knows as already gone', async () => {
    await seedHostDomain(db, { id: 'dom_a', fullDomain: 'a.com' });
    const { deps: d, mailpool } = deps();
    const row = await connectDomain(d, 'dom_a');
    mailpool.deleteDomain.mockRejectedValueOnce(new MailpoolError({ method: 'DELETE', path: '/domains/5000', status: 404 }));

    await disconnectDomain(d, row.id);
    expect(await listDomains(db)).toHaveLength(0);
  });

  it('keeps the domain (and its previous status) when Mailpool fails', async () => {
    await seedHostDomain(db, { id: 'dom_a', fullDomain: 'a.com' });
    const { deps: d, mailpool } = deps();
    const row = await connectDomain(d, 'dom_a');
    mailpool.deleteDomain.mockRejectedValueOnce(new MailpoolError({ method: 'DELETE', path: '/domains/5000', status: 502 }));

    await expect(disconnectDomain(d, row.id)).rejects.toBeInstanceOf(MailpoolError);
    const [stored] = await db.select().from(schema.reachDomains).where(eq(schema.reachDomains.id, row.id));
    expect(stored?.status).toBe('active');
    const [route] = await master.select().from(masterSchema.reachRoutes).where(eq(masterSchema.reachRoutes.externalId, '5000'));
    expect(route?.status).toBe('active');
  });
});

describe('listDomains', () => {
  it('counts non-deleted mailboxes per domain', async () => {
    await seedReachDomain(db, { id: 'rdom_1', hostDomainId: 'dom_1', name: 'a.com' });
    await seedMailbox(db, { id: 'rmbx_1', domainId: 'rdom_1' });
    await seedMailbox(db, { id: 'rmbx_2', domainId: 'rdom_1', status: 'warming' });
    await seedMailbox(db, { id: 'rmbx_3', domainId: 'rdom_1', status: 'deleted', deletedAt: new Date() });

    const [domain] = await listDomains(db);
    expect(domain).toMatchObject({ name: 'a.com', mailboxCount: 2 });
    expect(domain).not.toHaveProperty('forcedBy');
  });
});

