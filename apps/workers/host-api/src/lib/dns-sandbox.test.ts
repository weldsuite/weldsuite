/**
 * The WeldHost DNS sandbox, driven through the real `@weldsuite/cloudflare-zones`
 * functions (and so the real Cloudflare SDK) to prove it answers the way the
 * zone and record code expects Cloudflare to.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  CloudflareZoneError,
  __setZonesFetchForTests,
  createCloudflareZone,
  createDnsRecordInZone,
  deleteCloudflareZone,
  deleteDnsRecordInZone,
  findZoneIdByName,
  getCloudflareZone,
  listDnsRecordsInZone,
  updateDnsRecordInZone,
  type ZonesFetch,
} from '@weldsuite/cloudflare-zones';
import {
  DEFAULT_SANDBOX_NAMESERVERS,
  configureZonesSandbox,
  createSandboxZonesFetch,
  isSandboxZoneId,
  memorySandboxStore,
  sandboxNameserversFromEnv,
} from '@weldsuite/cloudflare-zones/sandbox';

const TOKEN = 'cf_token_unused';
const ACCOUNT = 'acct_test';

function sandbox(opts: { passthrough?: ZonesFetch; activateAfterMs?: number } = {}) {
  let clock = new Date('2026-10-22T10:00:00Z');
  const store = memorySandboxStore();
  __setZonesFetchForTests(
    createSandboxZonesFetch({
      store,
      passthrough: opts.passthrough,
      activateAfterMs: opts.activateAfterMs,
      now: () => clock,
    }),
  );
  return {
    store,
    advance(ms: number) {
      clock = new Date(clock.getTime() + ms);
    },
  };
}

afterEach(() => {
  __setZonesFetchForTests(undefined);
});

describe('DNS sandbox zones', () => {
  it('creates a pending sandbox zone that turns active after the delay', async () => {
    const { advance } = sandbox({ activateAfterMs: 60_000 });
    const zone = await createCloudflareZone(TOKEN, ACCOUNT, 'Acme-OTE.com');
    expect(isSandboxZoneId(zone.zoneId)).toBe(true);
    expect(zone.zoneId).toHaveLength(32);
    expect(zone).toMatchObject({ status: 'pending', nameservers: DEFAULT_SANDBOX_NAMESERVERS });

    expect(await getCloudflareZone(TOKEN, zone.zoneId)).toMatchObject({ status: 'pending' });
    advance(60_000);
    expect(await getCloudflareZone(TOKEN, zone.zoneId)).toMatchObject({ status: 'active' });
    expect(await findZoneIdByName(TOKEN, 'acme-ote.com')).toBe(zone.zoneId);
  });

  it('reports a second zone for the same name the way Cloudflare does', async () => {
    sandbox();
    await createCloudflareZone(TOKEN, ACCOUNT, 'acme-ote.com');
    await expect(createCloudflareZone(TOKEN, ACCOUNT, 'acme-ote.com')).rejects.toMatchObject({
      kind: 'DOMAIN_IN_ANOTHER_CF_ACCOUNT',
    });
  });

  it('rejects names that are not registrable domains', async () => {
    sandbox();
    await expect(createCloudflareZone(TOKEN, ACCOUNT, 'localhost')).rejects.toMatchObject({
      kind: 'INVALID_DOMAIN',
    });
  });

  it('returns null for a deleted zone and drops its records', async () => {
    const { store } = sandbox();
    const { zoneId } = await createCloudflareZone(TOKEN, ACCOUNT, 'acme-ote.com');
    await createDnsRecordInZone(TOKEN, zoneId, { type: 'A', name: '@', content: '192.0.2.1' });
    await deleteCloudflareZone(TOKEN, zoneId);
    expect(await getCloudflareZone(TOKEN, zoneId)).toBeNull();
    expect(await store.listRecords(zoneId)).toEqual([]);
  });
});

describe('DNS sandbox records', () => {
  async function zone() {
    sandbox();
    return (await createCloudflareZone(TOKEN, ACCOUNT, 'acme-ote.com')).zoneId;
  }

  it('round-trips every editable record type', async () => {
    const zoneId = await zone();
    await createDnsRecordInZone(TOKEN, zoneId, { type: 'A', name: '@', content: '192.0.2.1' });
    await createDnsRecordInZone(TOKEN, zoneId, { type: 'AAAA', name: 'v6', content: '2001:db8::1' });
    await createDnsRecordInZone(TOKEN, zoneId, { type: 'CNAME', name: 'www.acme-ote.com', content: 'acme-ote.com' });
    await createDnsRecordInZone(TOKEN, zoneId, { type: 'MX', name: '@', content: 'mx.example.net', priority: 10 });
    await createDnsRecordInZone(TOKEN, zoneId, { type: 'TXT', name: '_dmarc', content: 'v=DMARC1; p=none' });
    await createDnsRecordInZone(TOKEN, zoneId, { type: 'CAA', name: '@', content: '0 issue "letsencrypt.org"' });
    await createDnsRecordInZone(TOKEN, zoneId, { type: 'SRV', name: '_sip._tcp', content: '10 5 5060 sip.example.net' });

    const records = await listDnsRecordsInZone(TOKEN, zoneId);
    const byType = Object.fromEntries(records.map((r) => [r.type, r]));
    expect(records).toHaveLength(7);
    expect(byType.A).toMatchObject({ name: 'acme-ote.com', content: '192.0.2.1' });
    expect(byType.AAAA).toMatchObject({ name: 'v6.acme-ote.com' });
    expect(byType.CNAME).toMatchObject({ name: 'www.acme-ote.com', content: 'acme-ote.com' });
    expect(byType.MX).toMatchObject({ content: 'mx.example.net', priority: 10 });
    expect(byType.TXT).toMatchObject({ name: '_dmarc.acme-ote.com', content: 'v=DMARC1; p=none' });
    expect(byType.CAA).toMatchObject({ content: '0 issue "letsencrypt.org"' });
    expect(byType.SRV).toMatchObject({ name: '_sip._tcp.acme-ote.com', content: '10 5 5060 sip.example.net' });
  });

  it('lists more than one page of records', async () => {
    const zoneId = await zone();
    for (let i = 0; i < 105; i++) {
      await createDnsRecordInZone(TOKEN, zoneId, { type: 'TXT', name: `t${i}`, content: `v${i}` });
    }
    expect(await listDnsRecordsInZone(TOKEN, zoneId)).toHaveLength(105);
  });

  it('reports exact duplicates instead of creating them', async () => {
    const zoneId = await zone();
    const input = { type: 'TXT' as const, name: '@', content: 'weldhost-verify=abc' };
    expect(await createDnsRecordInZone(TOKEN, zoneId, input)).toMatchObject({ created: true });
    expect(await createDnsRecordInZone(TOKEN, zoneId, input)).toEqual({ created: false, duplicate: true });
  });

  it('refuses a CNAME next to other records at the same name', async () => {
    const zoneId = await zone();
    await createDnsRecordInZone(TOKEN, zoneId, { type: 'A', name: 'help', content: '192.0.2.1' });
    await expect(
      createDnsRecordInZone(TOKEN, zoneId, { type: 'CNAME', name: 'help', content: 'cname.vercel-dns.com' }),
    ).rejects.toBeInstanceOf(CloudflareZoneError);
  });

  it('refuses an A record that is not an IPv4 address', async () => {
    const zoneId = await zone();
    await expect(
      createDnsRecordInZone(TOKEN, zoneId, { type: 'A', name: '@', content: 'not-an-ip' }),
    ).rejects.toBeInstanceOf(CloudflareZoneError);
  });

  it('updates a record in place and deletes it once', async () => {
    const zoneId = await zone();
    const { record } = await createDnsRecordInZone(TOKEN, zoneId, { type: 'A', name: 'app', content: '192.0.2.1' });
    const updated = await updateDnsRecordInZone(TOKEN, zoneId, record!.id, {
      type: 'A',
      name: 'app',
      content: '192.0.2.2',
      ttl: 300,
    });
    expect(updated).toMatchObject({ id: record!.id, content: '192.0.2.2', ttl: 300 });

    expect(await deleteDnsRecordInZone(TOKEN, zoneId, record!.id)).toEqual({ deleted: true, alreadyGone: false });
    expect(await deleteDnsRecordInZone(TOKEN, zoneId, record!.id)).toEqual({ deleted: false, alreadyGone: true });
  });
});

describe('DNS sandbox overlay', () => {
  it('passes real zone ids and unknown names through to Cloudflare', async () => {
    const seen: string[] = [];
    const passthrough: ZonesFetch = async (input) => {
      seen.push(String(input instanceof Request ? input.url : input));
      return new Response(
        JSON.stringify({
          success: true,
          errors: [],
          messages: [],
          result: [{ id: 'f'.repeat(32), name: 'weldmail.org', status: 'active', name_servers: [] }],
          result_info: { page: 1, per_page: 20, count: 1, total_count: 1, total_pages: 1 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    };
    sandbox({ passthrough });

    expect(await findZoneIdByName(TOKEN, 'weldmail.org')).toBe('f'.repeat(32));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('https://api.cloudflare.com/client/v4/zones?');

    const { zoneId } = await createCloudflareZone(TOKEN, ACCOUNT, 'acme-ote.com');
    expect(await findZoneIdByName(TOKEN, 'acme-ote.com')).toBe(zoneId);
    expect(seen).toHaveLength(1);
  });
});

describe('configureZonesSandbox', () => {
  it('leaves the current transport alone unless the mode is sandbox', async () => {
    let calls = 0;
    const stub: ZonesFetch = async () => {
      calls += 1;
      return new Response(
        JSON.stringify({ success: true, errors: [], messages: [], result: { id: 'z1', name_servers: [], status: 'pending' } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    };
    __setZonesFetchForTests(stub);
    configureZonesSandbox({ ENVIRONMENT: 'test' });
    await createCloudflareZone(TOKEN, ACCOUNT, 'acme-ote.com');
    expect(calls).toBe(1);
  });

  it('refuses to run in production or without its D1', () => {
    expect(() =>
      configureZonesSandbox({ ENVIRONMENT: 'production', WELDHOST_DNS_MODE: 'sandbox', DNS_SANDBOX: {} as never }),
    ).toThrow(/production/);
    expect(() => configureZonesSandbox({ ENVIRONMENT: 'test', WELDHOST_DNS_MODE: 'sandbox' })).toThrow(/DNS_SANDBOX/);
  });

  it('parses configured nameservers', () => {
    expect(sandboxNameserversFromEnv({ DNS_SANDBOX_NAMESERVERS: ' NS1.example.net, ns2.example.net ,' })).toEqual([
      'ns1.example.net',
      'ns2.example.net',
    ]);
    expect(sandboxNameserversFromEnv({})).toEqual([]);
  });
});
