/**
 * WeldHost through the public API: domains (the managed registrar shown as
 * WeldSuite, unpaid checkouts hidden), their DNS zones and records (local
 * rows: the public API never calls a DNS host), and the WeldReach guard that
 * keeps a connected domain's DNS where Mailpool put it.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { createExternalTestApp } from './harness';
import { createPgliteDb } from './pglite';
import type { Database } from '../db';
import { schema } from '../db';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

const api = (scopes: string[] = ['domains:read', 'domains:write']) => createExternalTestApp({ scopes, tenantDb: db });
const get = (path: string) => api().request(path);
const post = (path: string, body: unknown) =>
  api().request(path, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) });
const patch = (path: string, body: unknown) =>
  api().request(path, { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(body) });
const del = (path: string) => api().request(path, { method: 'DELETE' });

async function data<T = Record<string, unknown>>(res: Response): Promise<T> {
  return ((await res.json()) as { data: T }).data;
}

async function newDomain(name: string, extra: Record<string, unknown> = {}): Promise<{ id: string; registrar: string }> {
  const res = await post('/v1/domains', { name, tld: 'test', fullDomain: `${name}.test`, ...extra });
  expect(res.status, await res.clone().text()).toBe(201);
  return data(res);
}

describe('external-api · domains', () => {
  it('shows a managed registrar as WeldSuite, lists by search and status, and hides unpaid checkouts', async () => {
    const managed = await newDomain('extdom-managed', { registrar: 'cloudflare', status: 'active' });
    expect(managed.registrar).toBe('WeldSuite');
    const outside = await newDomain('extdom-outside', { registrar: 'GoDaddy' });
    expect(outside.registrar).toBe('GoDaddy');

    const listed = await get('/v1/domains?search=extdom-&status=active');
    expect(listed.status).toBe(200);
    const rows = await data<{ id: string; registrar: string }[]>(listed);
    expect(rows.map((r) => r.id)).toEqual([managed.id]);
    expect(rows[0]?.registrar).toBe('WeldSuite');
    const all = await data<{ id: string }[]>(await get('/v1/domains?search=extdom-&status=all'));
    expect(all.map((r) => r.id).sort()).toEqual([managed.id, outside.id].sort());

    // An unpaid checkout is neither listed nor read.
    await db
      .update(schema.hostDomains)
      .set({ registrationStatus: 'pending_payment' } as Partial<typeof schema.hostDomains.$inferInsert>)
      .where(eq(schema.hostDomains.id, outside.id));
    expect((await data<{ id: string }[]>(await get('/v1/domains?search=extdom-'))).map((r) => r.id)).toEqual([managed.id]);
    expect((await get(`/v1/domains/${outside.id}`)).status).toBe(404);

    const updated = await patch(`/v1/domains/${managed.id}`, { notes: 'renewed', expiresAt: '2030-01-01T00:00:00.000Z' });
    expect(updated.status, await updated.clone().text()).toBe(200);
    expect((await data<{ expiresAt: string }>(updated)).expiresAt).toBe('2030-01-01T00:00:00.000Z');
    expect((await patch('/v1/domains/dom_missing', { notes: 'x' })).status).toBe(404);
    expect((await del('/v1/domains/dom_missing')).status).toBe(404);
  });

  it('writes zones and records under a domain, and lists them', async () => {
    const domain = await newDomain('extdom-dns');
    const zoneRes = await post(`/v1/domains/${domain.id}/zones`, { domainId: domain.id, name: 'extdom-dns.test' });
    expect(zoneRes.status, await zoneRes.clone().text()).toBe(201);
    const zone = await data<{ id: string; domainId: string; status: string; defaultTtl: number }>(zoneRes);
    expect(zone).toMatchObject({ domainId: domain.id, status: 'pending', defaultTtl: 3600 });
    expect((await post(`/v1/domains/${domain.id}/zones`, { name: 'no-domain.test' })).status).toBe(400);

    const zones = await data<{ id: string }[]>(await get(`/v1/domains/${domain.id}/zones`));
    expect(zones.map((z) => z.id)).toEqual([zone.id]);
    expect((await get(`/v1/domains/${domain.id}/zones/${zone.id}`)).status).toBe(200);
    expect((await get(`/v1/domains/${domain.id}/zones/zone_missing`)).status).toBe(404);
    const zonePatched = await patch(`/v1/domains/${domain.id}/zones/${zone.id}`, {
      status: 'active',
      syncedAt: '2026-01-02T03:04:05.000Z',
    });
    expect(zonePatched.status, await zonePatched.clone().text()).toBe(200);
    expect(await data(zonePatched)).toMatchObject({ status: 'active', syncedAt: '2026-01-02T03:04:05.000Z' });
    expect((await patch(`/v1/domains/${domain.id}/zones/zone_missing`, { status: 'active' })).status).toBe(404);

    const base = `/v1/domains/${domain.id}/zones/${zone.id}/records`;
    const recordRes = await post(base, { type: 'A', name: '@', value: '192.0.2.1', ttl: 300 });
    expect(recordRes.status, await recordRes.clone().text()).toBe(201);
    const record = await data<{ id: string; zoneId: string }>(recordRes);
    expect(record.zoneId).toBe(zone.id);
    expect((await post(base, { type: 'BOGUS', name: '@', value: 'x' })).status).toBe(400);
    expect((await data<{ id: string }[]>(await get(base))).map((r) => r.id)).toEqual([record.id]);
    expect((await get(`${base}/${record.id}`)).status).toBe(200);
    expect((await get(`${base}/rec_missing`)).status).toBe(404);
    // The update schema is the create schema: every field again.
    expect((await patch(`${base}/${record.id}`, { value: '192.0.2.2' })).status).toBe(400);
    const recordPatched = await patch(`${base}/${record.id}`, { type: 'A', name: 'www', value: '192.0.2.2' });
    expect(recordPatched.status).toBe(200);
    expect(await data(recordPatched)).toMatchObject({ name: 'www', value: '192.0.2.2' });
    expect((await patch(`${base}/rec_missing`, { type: 'A', name: '@', value: '192.0.2.3' })).status).toBe(404);
    expect((await del(`${base}/${record.id}`)).status).toBe(204);
    expect((await del(`${base}/${record.id}`)).status).toBe(404);

    expect((await del(`/v1/domains/${domain.id}/zones/${zone.id}`)).status).toBe(204);
    expect((await del(`/v1/domains/${domain.id}/zones/${zone.id}`)).status).toBe(404);
    expect((await del(`/v1/domains/${domain.id}`)).status).toBe(204);
  });

  it('refuses to move or delete the DNS of a domain connected to WeldReach', async () => {
    const domain = await newDomain('extdom-reach');
    const zone = await data<{ id: string }>(
      await post(`/v1/domains/${domain.id}/zones`, { domainId: domain.id, name: 'extdom-reach.test' }),
    );
    await db.insert(schema.reachDomains).values({
      id: 'rdom_extdom_reach',
      hostDomainId: domain.id,
      name: 'extdom-reach.test',
      status: 'active',
    } as typeof schema.reachDomains.$inferInsert);

    const refused = await patch(`/v1/domains/${domain.id}`, { nameservers: ['ns1.example.com'] });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({
      error: { code: 'DOMAIN_IN_USE_BY_WELDREACH', message: 'Disconnect this domain in WeldReach first.' },
    });
    // Notes are not DNS.
    expect((await patch(`/v1/domains/${domain.id}`, { notes: 'still mine' })).status).toBe(200);
    expect((await del(`/v1/domains/${domain.id}`)).status).toBe(409);
    expect((await patch(`/v1/domains/${domain.id}/zones/${zone.id}`, { status: 'active' })).status).toBe(409);
    expect((await del(`/v1/domains/${domain.id}/zones/${zone.id}`)).status).toBe(409);

    // Disconnecting releases it.
    await db
      .update(schema.reachDomains)
      .set({ status: 'disconnecting' } as Partial<typeof schema.reachDomains.$inferInsert>)
      .where(eq(schema.reachDomains.id, 'rdom_extdom_reach'));
    expect((await del(`/v1/domains/${domain.id}/zones/${zone.id}`)).status).toBe(204);
    expect((await del(`/v1/domains/${domain.id}`)).status).toBe(204);
  });

  it('keeps zones and records behind the domains scopes', async () => {
    const reader = createExternalTestApp({ scopes: ['domains:read'], tenantDb: db });
    const res = await reader.request('/v1/domains/dom_x/zones', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ domainId: 'dom_x', name: 'x.test' }),
    });
    expect(res.status).toBe(403);
    const none = createExternalTestApp({ scopes: ['unrelated:read'], tenantDb: db });
    expect((await none.request('/v1/domains/dom_x/zones/zone_x/records')).status).toBe(403);
  });
});
