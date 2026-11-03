/**
 * host-api's provider paths on pglite, with the providers stubbed by URL
 * (../test/provider-stub.ts): the registrar toggles, sync, auth codes and registration polling on
 * Realtime Register and the legacy Cloudflare Registrar, incoming transfers
 * and their sync, the ownership check (DNS over HTTPS, then a Cloudflare
 * zone), the zone status refresh, the DNS record routes on Cloudflare, and
 * Realtime Register's webhook. Search and availability are in
 * host-search.integration.test.ts.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { conformanceTenantDb, createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { createMemoryKv } from '@weldsuite/worker-kit/testing/d1';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type { Hono } from 'hono';
import { CF_ENV, RTR_ENV, createProviderFetchStub } from '../test/provider-stub';

const holder = vi.hoisted(() => ({ tenant: null as unknown }));
vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/worker-kit/db')>();
  return {
    ...actual,
    getTenantDbForWorkspace: async () => conformanceTenantDb(holder.tenant),
  };
});

import { dnsRecordsRoutes } from './dns-records';
import { domainTransfersRoutes } from './domain-transfers';
import { domainsRoutes } from './domains';
import { realtimeRegisterWebhookRoutes } from './webhooks-realtime-register';
import type { Env, Variables } from '../types';

const { hostDomains, hostDnsZones, hostDnsRecords, hostDomainTransfers, mailDomains } = schema;

let db: Database;
const TOKEN = '0123456789abcdef0123456789abcdef';

beforeAll(async () => {
  vi.stubGlobal('fetch', createProviderFetchStub());
  db = (await createPgliteDb()).db;
  holder.tenant = db;
  const domain = (id: string, fullDomain: string, values: Partial<typeof hostDomains.$inferInsert> = {}) => ({
    id,
    name: fullDomain.split('.')[0]!,
    tld: fullDomain.split('.').slice(1).join('.'),
    fullDomain,
    status: 'active' as const,
    ...values,
  });
  const rtr = (id: string, fullDomain: string, values: Partial<typeof hostDomains.$inferInsert> = {}) =>
    domain(id, fullDomain, { registrar: 'realtimeregister', externalRegistrarId: fullDomain, ...values });
  await db.insert(hostDomains).values([
    rtr('dom_pv_rtr', 'rtr-one.com', { registrationStatus: 'registered' }),
    rtr('dom_pv_unlocked', 'unlocked-rtr.com'),
    rtr('dom_pv_denied', 'denied-rtr.com'),
    rtr('dom_pv_boom', 'boom-rtr.com'),
    rtr('dom_pv_async', 'async-rtr.com'),
    rtr('dom_pv_lockedout', 'locked-out-rtr.com'),
    rtr('dom_pv_de', 'privacy.de'),
    rtr('dom_pv_missing', 'missing-rtr.com'),
    rtr('dom_pv_inflight', 'inflight-rtr.com', { status: 'pending', registrationStatus: 'pending_transfer' }),
    rtr('dom_pv_withcode', 'withcode-rtr.com'),
    rtr('dom_pv_infocode', 'infocode-rtr.com'),
    domain('dom_pv_cf', 'cf-one.com', { registrar: 'cloudflare', externalRegistrarId: 'cf-one.com', registrationStatus: 'pending_payment' }),
    domain('dom_pv_cfdenied', 'denied-cf.com', { registrar: 'cloudflare', externalRegistrarId: 'denied-cf.com' }),
    domain('dom_pv_cfrefused', 'refused-cf.com', { registrar: 'cloudflare', externalRegistrarId: 'refused-cf.com' }),
    domain('dom_pv_external', 'outside.com', { registrar: 'GoDaddy' }),
    // registrations
    domain('dom_pv_done', 'done-reg.com', { status: 'pending', registrationStatus: 'pending_workflow', rtrProcessId: '1001' }),
    domain('dom_pv_failreg', 'fail-reg.com', { status: 'pending', registrationStatus: 'pending_registration', rtrProcessId: '1003' }),
    domain('dom_pv_waitreg', 'wait-reg.com', { status: 'pending', registrationStatus: 'pending_workflow', rtrProcessId: '1002' }),
    domain('dom_pv_renewwait', 'renew-wait.com', { registrationStatus: 'pending_renewal', rtrProcessId: '1001' }),
    domain('dom_pv_badpid', 'bad-pid.com', { status: 'pending', registrationStatus: 'pending_workflow', rtrProcessId: 'abc' }),
    domain('dom_pv_missingreg', 'missing-reg.com', { status: 'pending', registrationStatus: 'pending_workflow', rtrProcessId: '1001' }),
    // transfers
    domain('dom_pv_transferme', 'transfer-me.com', {
      registrar: 'GoDaddy',
      nameservers: ['ns1.godaddy.com', 'ns2.godaddy.com'],
      registrantContact: { firstName: 'Ada', email: 'ada@example.com' },
    }),
    domain('dom_pv_syncme', 'sync-me.com', { registrar: 'GoDaddy', status: 'pending' }),
    domain('dom_pv_syncmissing', 'missing-sync.com', { registrar: 'GoDaddy', status: 'pending', expiresAt: new Date('2026-09-09T00:00:00Z') }),
    // ownership
    ...['verified-site.com', 'taken-site.com', 'invalid-site.com', 'forbidden-site.com', 'weird-site.com', 'wrong-site.com', 'dnsdown-site.com'].map(
      (name) => domain(`dom_pv_own_${name.split('-')[0]}`, name, { status: 'pending', registrar: 'External', nameserverVerificationToken: TOKEN }),
    ),
    domain('dom_pv_own_unconfigured', 'verified-site.com', { status: 'pending', registrar: 'External', nameserverVerificationToken: TOKEN }),
    // zone status
    domain('dom_pv_zactive', 'ext-active.com', { status: 'pending', registrar: 'External' }),
    domain('dom_pv_zgone', 'zone-gone.com'),
    domain('dom_pv_zforbidden', 'zone-forbidden.com'),
    domain('dom_pv_zmoved', 'zone-moved.com'),
    domain('dom_pv_zsame', 'zone-same.com'),
    // dns records
    domain('dom_pv_live', 'live-site.com'),
    domain('dom_pv_scan', 'scan-site.com'),
    domain('dom_pv_e1', 'edit-one.com'),
    domain('dom_pv_e2', 'edit-two.com'),
    domain('dom_pv_e3', 'edit-three.com'),
    domain('dom_pv_e4', 'edit-four.com'),
    // webhook
    domain('dom_pv_hookreg', 'hook-reg.com', { status: 'pending', registrationStatus: 'pending_workflow', rtrProcessId: '1001' }),
    domain('dom_pv_hookrenew', 'hook-renew.com', { registrationStatus: 'pending_renewal', metadata: { rtrRenewalProcessId: '1003', note: 'keep' } }),
    domain('dom_pv_hooktransfer', 'hook-transfer.com', { status: 'pending' }),
  ]);
  const zone = (id: string, domainId: string, name: string, externalZoneId: string, values: Partial<typeof hostDnsZones.$inferInsert> = {}) => ({
    id,
    domainId,
    name,
    status: 'pending' as const,
    provider: 'cloudflare' as const,
    externalZoneId,
    ...values,
  });
  await db.insert(hostDnsZones).values([
    zone('zone_pv_zactive', 'dom_pv_zactive', 'ext-active.com', 'cfz_active'),
    zone('zone_pv_zgone', 'dom_pv_zgone', 'zone-gone.com', 'cfz_gone', { status: 'active' }),
    zone('zone_pv_zforbidden', 'dom_pv_zforbidden', 'zone-forbidden.com', 'cfz_forbidden'),
    zone('zone_pv_zmoved', 'dom_pv_zmoved', 'zone-moved.com', 'cfz_moved', { status: 'active' }),
    zone('zone_pv_zsame', 'dom_pv_zsame', 'zone-same.com', 'cfz_pending'),
    zone('zone_pv_live', 'dom_pv_live', 'live-site.com', 'cfz_live'),
    zone('zone_pv_drift', 'dom_pv_live', 'live-site.com', 'cfz_live', { syncedAt: new Date(), deletedAt: new Date() }),
    zone('zone_pv_scan', 'dom_pv_scan', 'scan-site.com', 'cfz_scan', { syncedAt: new Date() }),
    zone('zone_pv_e1', 'dom_pv_e1', 'edit-one.com', 'cfz_e1', { syncedAt: new Date() }),
    zone('zone_pv_e2', 'dom_pv_e2', 'edit-two.com', 'cfz_e2', { syncedAt: new Date() }),
    zone('zone_pv_e3', 'dom_pv_e3', 'edit-three.com', 'cfz_e3', { syncedAt: new Date() }),
    zone('zone_pv_e4', 'dom_pv_e4', 'edit-four.com', 'cfz_forbidden', { syncedAt: new Date() }),
  ]);
  const record = (id: string, zoneId: string, values: Partial<typeof hostDnsRecords.$inferInsert>) => ({
    id,
    zoneId,
    type: 'A' as const,
    name: 'x',
    value: '192.0.2.1',
    status: 'active' as const,
    ...values,
  });
  await db.insert(hostDnsRecords).values([
    // the drift zone: one record drifted, one gone at Cloudflare, one never synced, one unchanged
    record('dnsrec_pv_drift', 'zone_pv_drift', { externalRecordId: 'cfr_a', name: 'live-site.com', value: '203.0.113.99', ttl: 300 }),
    record('dnsrec_pv_stale', 'zone_pv_drift', { externalRecordId: 'cfr_stale' }),
    record('dnsrec_pv_local', 'zone_pv_drift', { externalRecordId: null }),
    record('dnsrec_pv_same', 'zone_pv_drift', { externalRecordId: 'cfr_mx', type: 'MX', name: 'live-site.com', value: 'mx.live-site.com', ttl: 3600, priority: 10 }),
    record('dnsrec_pv_e1', 'zone_pv_e1', { externalRecordId: 'cfr_e1', name: 'www.edit-one.com' }),
    record('dnsrec_pv_e2', 'zone_pv_e2', { externalRecordId: 'cfr_gone', name: 'old.edit-two.com' }),
    record('dnsrec_pv_e3', 'zone_pv_e3', { externalRecordId: 'cfr_stuck', name: 'stuck.edit-three.com' }),
    record('dnsrec_pv_e4', 'zone_pv_e4', { externalRecordId: 'cfr_e4', name: 'reject.edit-four.com' }),
  ]);
  await db.insert(mailDomains).values({
    id: 'mdom_pv_live',
    domainName: 'live-site.com',
    dnsRecords: [
      { type: 'MX', name: 'live-site.com.', purpose: 'mx', value: 'mx.live-site.com' },
      { type: 'TXT', name: 'live-site.com', purpose: 'spf', value: 'v=spf1 include:mail.example -all' },
      { type: 'TXT', name: 'x._domainkey.live-site.com', value: 'no purpose' },
    ],
  } as typeof mailDomains.$inferInsert);
  await db.insert(hostDomainTransfers).values([
    { id: 'txfr_pv_done', domainId: 'dom_pv_syncme', domainName: 'sync-me.com', type: 'incoming', status: 'pending_approval', externalTransferId: '1001' },
    { id: 'txfr_pv_failed', domainId: null, domainName: 'fail-tx.com', type: 'incoming', status: 'pending_approval', externalTransferId: '1003' },
    { id: 'txfr_pv_running', domainId: null, domainName: 'run-tx.com', type: 'incoming', status: 'in_progress', externalTransferId: '1002' },
    { id: 'txfr_pv_local', domainId: null, domainName: 'local-tx.com', type: 'outgoing', status: 'pending' },
    { id: 'txfr_pv_nan', domainId: null, domainName: 'nan-tx.com', type: 'incoming', status: 'pending', externalTransferId: 'x9' },
    { id: 'txfr_pv_missing', domainId: 'dom_pv_syncmissing', domainName: 'missing-sync.com', type: 'incoming', status: 'pending', externalTransferId: '1001' },
    { id: 'txfr_pv_unknownproc', domainId: null, domainName: 'odd-tx.com', type: 'incoming', status: 'pending', externalTransferId: '4040' },
    { id: 'txfr_pv_hook', domainId: 'dom_pv_hooktransfer', domainName: 'hook-transfer.com', type: 'incoming', status: 'pending', externalTransferId: '1002' },
  ]);
}, 60_000);

afterAll(() => {
  vi.unstubAllGlobals();
});

type Routes = Hono<{ Bindings: Env; Variables: Variables }>;

function api(base: string, routes: Routes, env: Record<string, unknown> = {}, kv = createMemoryKv()) {
  return createTestApp(base, routes, {
    context: { permissions: permissions('*'), tenantDb: db },
    env: { WORKSPACE_CACHE: kv, ...env } as never,
  });
}

const send = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

const domains = (env: Record<string, unknown> = { ...RTR_ENV, ...CF_ENV }) => api('/api/domains', domainsRoutes, env).request;

async function data<T>(res: Response): Promise<T> {
  return ((await res.json()) as { data: T }).data;
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Registrar toggles, sync, auth codes
// ---------------------------------------------------------------------------

describe('domains: Realtime Register actions', () => {
  it('turns auto-renew off at the registrar, Stripe owning renewals', async () => {
    const request = domains();
    const res = await request('/api/domains/dom_pv_rtr/toggle-auto-renew', send('POST', { enabled: true }));
    expect(res.status).toBe(200);
    expect((await data<{ autoRenew: boolean }>(res)).autoRenew).toBe(true);
    expect((await request('/api/domains/dom_pv_async/toggle-auto-renew', send('POST', { enabled: false }))).status).toBe(200);
  });

  it('toggles privacy where the TLD allows it', async () => {
    const request = domains();
    expect((await request('/api/domains/dom_pv_de/toggle-privacy', send('POST', { enabled: true }))).status).toBe(500);
    expect((await request('/api/domains/dom_pv_de/toggle-privacy', send('POST', { enabled: false }))).status).toBe(200);
    expect((await request('/api/domains/dom_pv_boom/toggle-privacy', send('POST', { enabled: true }))).status).toBe(502);
  });

  it('sets the transfer lock through the domain status', async () => {
    const request = domains();
    expect((await request('/api/domains/dom_pv_unlocked/toggle-lock', send('POST', { locked: true }))).status).toBe(200);
    expect((await request('/api/domains/dom_pv_rtr/toggle-lock', send('POST', { locked: false }))).status).toBe(200);
    const denied = await request('/api/domains/dom_pv_denied/toggle-lock', send('POST', { locked: true }));
    expect(denied.status).toBe(502);
    expect(((await denied.json()) as { error: { code: string } }).error.code).toBe('REGISTRAR_UNAUTHORIZED');
    const refused = await request('/api/domains/dom_pv_lockedout/toggle-auto-renew', send('POST', { enabled: false }));
    expect(refused.status).toBe(400);
  });

  it('syncs from the registrar', async () => {
    const request = domains();
    const synced = await data<{ registrationStatus: string; locked: boolean; registrarStatus: string }>(
      await request('/api/domains/dom_pv_rtr/sync', send('POST')),
    );
    expect(synced).toMatchObject({ registrationStatus: 'registered', locked: true, registrarStatus: 'OK,CLIENT_TRANSFER_PROHIBITED' });
    const inflight = await data<{ registrationStatus: string; status: string }>(await request('/api/domains/dom_pv_inflight/sync', send('POST')));
    expect(inflight).toMatchObject({ registrationStatus: 'pending_transfer', status: 'active' });
    expect((await request('/api/domains/dom_pv_missing/sync', send('POST'))).status).toBe(500);
    expect((await request('/api/domains/dom_pv_external/sync', send('POST'))).status).toBe(200);
    expect((await request('/api/domains/dom_nope/sync', send('POST'))).status).toBe(404);
  });

  it('fetches auth codes', async () => {
    const request = domains();
    const fromDomain = await request('/api/domains/dom_pv_withcode/auth-code', send('POST'));
    expect(fromDomain.status).toBe(200);
    expect(((await fromDomain.json()) as { authCode: string }).authCode).toBe('EPP-WITH-CODE');
    const fromInfo = await request('/api/domains/dom_pv_infocode/auth-code', send('POST'));
    expect(((await fromInfo.json()) as { authCode: string }).authCode).toBe('EPP-FROM-INFO');
    expect((await request('/api/domains/dom_pv_rtr/auth-code', send('POST'))).status).toBe(400);
    const denied = await request('/api/domains/dom_pv_denied/auth-code', send('POST'));
    expect(((await denied.json()) as { error: { message: string } }).error.message).toBe('Bad key');
  });

  it('drives registrations forward while they are polled', async () => {
    const request = domains();
    const status = async (id: string) => data<{ status: string; domainId: string | null }>(await request(`/api/domains/registrations/${id}/status`));
    expect(await status('dom_pv_done')).toMatchObject({ status: 'completed', domainId: 'dom_pv_done' });
    expect((await status('dom_pv_failreg')).status).toBe('failed');
    expect((await status('dom_pv_waitreg')).status).toBe('registering');
    expect((await status('dom_pv_renewwait')).status).toBe('completed');
    expect((await status('dom_pv_badpid')).status).toBe('registering');
    expect((await status('dom_pv_missingreg')).status).toBe('registering');
  });
});

describe('domains: Cloudflare Registrar actions', () => {
  it('toggles auto-renew and the lock, and syncs', async () => {
    const request = domains();
    expect((await request('/api/domains/dom_pv_cf/toggle-auto-renew', send('POST', { enabled: false }))).status).toBe(200);
    expect((await request('/api/domains/dom_pv_cf/toggle-lock', send('POST', { locked: true }))).status).toBe(200);
    const synced = await data<{ registrationStatus: string; autoRenew: boolean; expiresAt: string }>(
      await request('/api/domains/dom_pv_cf/sync', send('POST')),
    );
    expect(synced).toMatchObject({ registrationStatus: 'pending_payment', autoRenew: true, expiresAt: '2027-02-03T04:05:06.000Z' });
  });

  it('maps Cloudflare refusals', async () => {
    const request = domains();
    const denied = await request('/api/domains/dom_pv_cfdenied/toggle-lock', send('POST', { locked: true }));
    expect(denied.status).toBe(502);
    const refused = await request('/api/domains/dom_pv_cfrefused/toggle-auto-renew', send('POST', { enabled: true }));
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: { message: string } }).error.message).toBe(
      'Cloudflare API 400 on registrations: Registrar refused the change (code 1001)',
    );
    expect((await request('/api/domains/dom_pv_cfdenied/sync', send('POST'))).status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// Transfers
// ---------------------------------------------------------------------------

describe('domain transfers: Realtime Register', () => {
  const transfers = (env: Record<string, unknown> = RTR_ENV, kv = createMemoryKv()) =>
    api('/api/domain-transfers', domainTransfersRoutes, env, kv).request;

  it('starts an incoming transfer and maps its process for the webhook', async () => {
    const kv = createMemoryKv();
    const res = await transfers(RTR_ENV, kv)('/api/domain-transfers', send('POST', { domainName: 'Incoming-One.com', type: 'incoming', authCode: 'EPP1' }));
    expect(res.status).toBe(201);
    const row = await data<{ status: string; externalTransferId: string; domainId: string }>(res);
    expect(row).toMatchObject({ status: 'pending_approval', externalTransferId: '9001' });
    expect(row.domainId).toMatch(/^dom_/);
    expect(JSON.parse(kv.store.get('rtr:process:9001')!)).toMatchObject({ workspaceId: 'org_test_default', kind: 'transfer' });
  });

  it('moves an existing domain in with its stored contact and nameservers', async () => {
    const res = await transfers()('/api/domain-transfers', send('POST', { domainId: 'dom_pv_transferme', domainName: 'transfer-me.com', type: 'incoming' }));
    expect(res.status).toBe(201);
    const [domain] = await db.select().from(hostDomains).where(eq(hostDomains.id, 'dom_pv_transferme'));
    expect(domain!.registrationStatus).toBe('pending_transfer');
  });

  it('retries without privacy protection when the registry refuses it', async () => {
    const res = await transfers()('/api/domain-transfers', send('POST', { domainName: 'noprivacy-in.com', type: 'incoming' }));
    expect(res.status).toBe(201);
  });

  it('records a refused transfer as failed', async () => {
    const res = await transfers()('/api/domain-transfers', send('POST', { domainName: 'refused-in.com', type: 'incoming', authCode: 'bad' }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe('The auth code is wrong');
    const env = { REALTIME_REGISTER_API_KEY: 'k', REALTIME_REGISTER_CUSTOMER: 'c' };
    expect((await transfers(env)('/api/domain-transfers', send('POST', { domainName: 'nocontacts.com', type: 'incoming' }))).status).toBe(500);
  });

  it('syncs transfers from their registrar process', async () => {
    const request = transfers();
    const done = await data<{ status: string }>(await request('/api/domain-transfers/txfr_pv_done/sync', send('PATCH')));
    expect(done.status).toBe('completed');
    const [domain] = await db.select().from(hostDomains).where(eq(hostDomains.id, 'dom_pv_syncme'));
    expect(domain).toMatchObject({ status: 'active', registrationStatus: 'transferred', registrar: 'realtimeregister' });
    expect((await data<{ status: string }>(await request('/api/domain-transfers/txfr_pv_failed/sync', send('PATCH')))).status).toBe('failed');
    expect((await data<{ status: string }>(await request('/api/domain-transfers/txfr_pv_running/sync', send('PATCH')))).status).toBe('in_progress');
    expect((await data<{ status: string }>(await request('/api/domain-transfers/txfr_pv_local/sync', send('PATCH')))).status).toBe('pending');
    expect((await data<{ status: string }>(await request('/api/domain-transfers/txfr_pv_nan/sync', send('PATCH')))).status).toBe('pending');
    expect((await data<{ status: string }>(await request('/api/domain-transfers/txfr_pv_missing/sync', send('PATCH')))).status).toBe('completed');
    expect((await request('/api/domain-transfers/txfr_pv_unknownproc/sync', send('PATCH'))).status).toBe(500);
    expect((await request('/api/domain-transfers/txfr_nope/sync', send('PATCH'))).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Ownership and zones
// ---------------------------------------------------------------------------

describe('domains: ownership check and zone status', () => {
  const env = { ...CF_ENV };

  it('creates the Cloudflare zone once the TXT record is there', async () => {
    const res = await domains(env)('/api/domains/dom_pv_own_verified/verify-ownership', send('POST'));
    expect(res.status).toBe(200);
    const body = await data<{ nameservers: string[]; nameserverVerified: boolean; dnsZone: { externalZoneId: string } }>(res);
    expect(body).toMatchObject({ nameservers: ['ada.ns.cloudflare.com', 'bob.ns.cloudflare.com'], nameserverVerified: true });
    expect(body.dnsZone.externalZoneId).toBe('cfz_verified-site');
  });

  it('answers what the lookup and Cloudflare say', async () => {
    const request = domains(env);
    const missing = await request('/api/domains/dom_pv_own_wrong/verify-ownership', send('POST'));
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { error: { code: string; details: { found: string[] } } }).error).toMatchObject({
      code: 'VERIFICATION_FAILED',
      details: { found: ['weldhost-verify=nope'] },
    });
    expect((await request('/api/domains/dom_pv_own_dnsdown/verify-ownership', send('POST'))).status).toBe(503);
    expect((await request('/api/domains/dom_pv_own_taken/verify-ownership', send('POST'))).status).toBe(409);
    expect((await request('/api/domains/dom_pv_own_invalid/verify-ownership', send('POST'))).status).toBe(400);
    expect((await request('/api/domains/dom_pv_own_forbidden/verify-ownership', send('POST'))).status).toBe(500);
    expect((await request('/api/domains/dom_pv_own_weird/verify-ownership', send('POST'))).status).toBe(500);
    expect((await domains({})('/api/domains/dom_pv_own_unconfigured/verify-ownership', send('POST'))).status).toBe(500);
  });

  it('refreshes a zone’s status from Cloudflare', async () => {
    const request = domains(env);
    const active = await data<{ zoneStatus: string; domainStatus: string }>(await request('/api/domains/dom_pv_zactive/refresh-zone-status', send('POST')));
    expect(active).toMatchObject({ zoneStatus: 'active', domainStatus: 'active' });
    const gone = await data<{ zoneStatus: string; cloudflareStatus: null }>(await request('/api/domains/dom_pv_zgone/refresh-zone-status', send('POST')));
    expect(gone).toMatchObject({ zoneStatus: 'error', cloudflareStatus: null });
    expect((await request('/api/domains/dom_pv_zforbidden/refresh-zone-status', send('POST'))).status).toBe(503);
    const moved = await data<{ zoneStatus: string }>(await request('/api/domains/dom_pv_zmoved/refresh-zone-status', send('POST')));
    expect(moved.zoneStatus).toBe('error');
    const same = await data<{ zoneStatus: string }>(await request('/api/domains/dom_pv_zsame/refresh-zone-status', send('POST')));
    expect(same.zoneStatus).toBe('pending');
  });
});

// ---------------------------------------------------------------------------
// DNS records on Cloudflare
// ---------------------------------------------------------------------------

describe('dns records on Cloudflare', () => {
  const records = () => api('/api/dns-records', dnsRecordsRoutes, CF_ENV).request;

  it('syncs a never-synced zone when it is listed, with WeldMail’s locks', async () => {
    const res = await records()('/api/dns-records/by-zone/zone_pv_live');
    expect(res.status).toBe(200);
    const body = await data<{ records: Array<{ type: string; value: string; metadata: { locks?: unknown[] } | null }>; zone: { syncedAt: string | null } }>(res);
    expect(body.records.map((r) => r.type).sort()).toEqual(['A', 'CAA', 'MX', 'SRV', 'TXT']);
    expect(body.records.find((r) => r.type === 'TXT')!.value).toBe('v=spf1 include:mail.example -all');
    expect(body.records.find((r) => r.type === 'SRV')!.value).toBe('10 5 5060 sip.live-site.com');
    expect(body.records.find((r) => r.type === 'MX')!.metadata?.locks).toHaveLength(1);
    expect(body.zone.syncedAt).not.toBeNull();
  });

  it('reconciles a zone: adds, updates, touches and removes', async () => {
    // the drift zone is soft-deleted, so the sync route refuses it; restore it first
    await db.update(hostDnsZones).set({ deletedAt: null }).where(eq(hostDnsZones.id, 'zone_pv_drift'));
    const res = await records()('/api/dns-records/by-zone/zone_pv_drift/sync', send('POST'));
    expect(res.status).toBe(200);
    const body = await data<{ added: number; updated: number; removed: number }>(res);
    expect(body).toEqual(expect.objectContaining({ added: 3, updated: 1, removed: 2 }));
  });

  it('reports a failed list as a 502 with the stored records', async () => {
    const res = await records()('/api/dns-records/by-zone/zone_pv_e4/sync', send('POST'));
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe(
      'Cloudflare API token is missing or lacks the required scope',
    );
  });

  it('creates records, a duplicate included, and reports a refusal', async () => {
    const request = records();
    expect((await request('/api/dns-records/by-domain/dom_pv_live', send('POST', { type: 'A', name: 'api', value: '198.51.100.7', ttl: 120, comment: 'API' }))).status).toBe(201);
    expect((await request('/api/dns-records/by-domain/dom_pv_live', send('POST', { type: 'TXT', name: 'dup-txt', value: 'hello "world"' }))).status).toBe(201);
    expect((await request('/api/dns-records/by-domain/dom_pv_live', send('POST', { type: 'SRV', name: '_x._tcp', value: '1 2 3 t.example', priority: 5 }))).status).toBe(201);
    expect((await request('/api/dns-records/by-domain/dom_pv_live', send('POST', { type: 'CAA', name: '@', value: '0 issue "pki.example"' }))).status).toBe(201);
    expect((await request('/api/dns-records/by-domain/dom_pv_live', send('POST', { type: 'NS', name: 'sub', value: 'ns.example' }))).status).toBe(201);
    expect((await request('/api/dns-records/by-domain/dom_pv_live', send('POST', { type: 'MX', name: '@', value: 'mx2.example' }))).status).toBe(201);
    const refused = await request('/api/dns-records/by-domain/dom_pv_live', send('POST', { type: 'A', name: 'reject', value: 'nope' }));
    expect(refused.status).toBe(422);
    expect(((await refused.json()) as { error: { message: string } }).error.message).toBe('Cloudflare API error 400: Content for A record is invalid.');
  });

  it('updates and deletes records at Cloudflare', async () => {
    const request = records();
    expect((await request('/api/dns-records/dnsrec_pv_e1', send('PATCH', { type: 'A', name: 'www', value: '198.51.100.8' }))).status).toBe(200);
    expect((await request('/api/dns-records/dnsrec_pv_e2', send('DELETE'))).status).toBe(200);
    expect((await request('/api/dns-records/dnsrec_pv_e3', send('DELETE'))).status).toBe(422);
    expect((await request('/api/dns-records/dnsrec_pv_e4', send('PATCH', { type: 'A', name: 'reject', value: '1.1.1.1' }))).status).toBe(422);
  });

  it('scans public DNS and imports what it may', async () => {
    const request = records();
    const scan = await request('/api/dns-records/by-domain/dom_pv_scan/scan', send('POST'));
    expect(scan.status).toBe(200);
    const found = await data<{ records: Array<{ type: string; name: string; value: string }> }>(scan);
    expect(found.records.map((r) => `${r.type} ${r.name}`)).toEqual([
      'A scan-site.com',
      'MX scan-site.com',
      'TXT scan-site.com',
      'CAA scan-site.com',
      'CNAME www.scan-site.com',
      'TXT _dmarc.scan-site.com',
    ]);
    const imported = await request(
      '/api/dns-records/by-domain/dom_pv_live/import',
      send('POST', {
        records: [
          { name: 'blog.live-site.com', type: 'A', value: '198.51.100.20', ttl: 300 },
          { name: '_weldhost-verify.live-site.com', type: 'TXT', value: 'weldhost-verify=x' },
          { name: 'cdn.live-site.com', type: 'CNAME', value: 'kim.ns.cloudflare.com' },
          { name: 'dup-a.live-site.com', type: 'A', value: '198.51.100.21' },
          { name: 'reject-a.live-site.com', type: 'A', value: '198.51.100.22' },
          { name: 'live-site.com', type: 'MX', value: 'mx3.example', priority: 20 },
        ],
      }),
    );
    expect(imported.status).toBe(200);
    expect(await data<{ imported: number; skipped: number; failed: unknown[] }>(imported)).toMatchObject({ imported: 2, skipped: 3 });
  });
});

// ---------------------------------------------------------------------------
// Realtime Register's webhook
// ---------------------------------------------------------------------------

describe('POST /public/webhooks/realtime-register', () => {
  const BASE = '/public/webhooks/realtime-register';
  const SECRET = 'hook-secret';
  const kv = createMemoryKv();
  const hook = (env: Record<string, unknown> = { ...RTR_ENV, REALTIME_REGISTER_WEBHOOK_SECRET: SECRET }) =>
    createTestApp(BASE, realtimeRegisterWebhookRoutes, {
      context: { tenantDb: db, orgId: null, clerkOrgId: null },
      env: { WORKSPACE_CACHE: kv, ...env } as never,
    }).request;
  const deliver = (body: string, token: string | null = SECRET, env?: Record<string, unknown>) =>
    hook(env)(`${BASE}${token === null ? '' : `?token=${token}`}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });

  beforeAll(async () => {
    await kv.put('rtr:process:1001', JSON.stringify({ workspaceId: 'org_test_default', domainId: 'dom_pv_hookreg', kind: 'registration' }));
    await kv.put('rtr:process:1002', JSON.stringify({ workspaceId: 'org_test_default', transferId: 'txfr_pv_hook', kind: 'transfer' }));
    await kv.put('rtr:process:1003', JSON.stringify({ workspaceId: 'org_test_default', domainId: 'dom_pv_hookrenew', kind: 'renewal' }));
    await kv.put('rtr:process:1004', 'not json');
  });

  it('answers a health check', async () => {
    const res = await hook()(BASE);
    expect(await res.json()).toEqual({ ok: true, service: 'realtime-register-webhook' });
  });

  it('refuses without the shared token', async () => {
    expect((await deliver('{}', SECRET, { ...RTR_ENV })).status).toBe(401);
    expect((await deliver('{}', 'wrong')).status).toBe(401);
    expect((await deliver('{}', null)).status).toBe(401);
  });

  it('acknowledges what it cannot act on', async () => {
    expect((await deliver('{not json')).status).toBe(400);
    expect(await (await deliver(JSON.stringify({ event: 'ping' }))).json()).toEqual({ received: true });
    expect(await (await deliver(JSON.stringify({ processId: 'x' }))).json()).toEqual({ received: true });
    const unconfigured = await deliver(JSON.stringify({ processId: 1001 }), SECRET, { REALTIME_REGISTER_WEBHOOK_SECRET: SECRET });
    expect(await unconfigured.json()).toEqual({ received: true, processId: 1001 });
    expect(await (await deliver(JSON.stringify({ data: { id: '9001' } }))).json()).toEqual({ received: true, processId: 9001, mapped: false });
    expect(await (await deliver(JSON.stringify({ process_id: 1004 }))).json()).toEqual({ received: true, processId: 1004, mapped: false });
  });

  it('advances the mapped registration, renewal and transfer', async () => {
    expect(await (await deliver(JSON.stringify({ processId: 1001 }))).json()).toEqual({ received: true, processId: 1001, mapped: true });
    expect(await (await deliver(JSON.stringify({ data: { processId: '1003' } }))).json()).toEqual({ received: true, processId: 1003, mapped: true });
    expect(await (await deliver(JSON.stringify({ processId: 1002 }))).json()).toEqual({ received: true, processId: 1002, mapped: true });
    const [renewal] = await db.select().from(hostDomains).where(eq(hostDomains.id, 'dom_pv_hookrenew'));
    expect(renewal!.registrationStatus).toBe('failed');
  });
});
