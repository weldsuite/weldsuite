/**
 * Contract tests for `@weldsuite/cloudflare-zones` — zone provisioning and DNS
 * record CRUD, used by WeldHost domains, the helpcenter custom-domain flow and
 * workspace mail provisioning.
 *
 * The helper moved from hand-written paths to the official `cloudflare` SDK.
 * The headline case is SRV and CAA: the old code posted a flat `content`
 * string for every record type, but Cloudflare takes a structured `data`
 * object for those two, so neither could ever have been created. Both are
 * user-selectable in the DNS UI, so these are pinned here.
 *
 * The package has no test runner of its own, so the tests live in app-api,
 * which already depends on it and runs vitest.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  createCloudflareZone,
  createDnsRecordInZone,
  deleteDnsRecordInZone,
  findZoneIdByName,
  getCloudflareZone,
  listDnsRecordsInZone,
  CloudflareZoneError,
  __setZonesFetchForTests,
  type ZonesFetch,
} from '@weldsuite/cloudflare-zones';

type FetchCall = { url: string; method: string | undefined; body: any };

const ok = (result: unknown, extra: Record<string, unknown> = {}) => ({
  success: true,
  errors: [],
  messages: [],
  result,
  ...extra,
});

/**
 * Serve the scripted responses in order, then an empty result set.
 *
 * The trailing empty page is load-bearing: the SDK's V4 pagination decides
 * there is a next page purely from whether the current one is non-empty (it
 * ignores `result_info`), so a stub that replays its last non-empty response
 * makes `listDnsRecordsInZone` page forever.
 */
function withResponses(responses: Array<{ status?: number; body: unknown }>) {
  const calls: FetchCall[] = [];
  let i = 0;
  const stub: ZonesFetch = async (input, init) => {
    const req = init as RequestInit | undefined;
    calls.push({
      url: String(input instanceof Request ? input.url : input),
      method: req?.method,
      body: req?.body ? JSON.parse(String(req.body)) : undefined,
    });
    const next = responses[i++] ?? { status: 200, body: ok([]) };
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  __setZonesFetchForTests(stub);
  return calls;
}

afterEach(() => {
  __setZonesFetchForTests(undefined);
});

describe('zones', () => {
  it('creates a zone and returns the assigned nameservers', async () => {
    const calls = withResponses([
      {
        body: ok({
          id: 'zone_1',
          name: 'example.com',
          status: 'pending',
          name_servers: ['ns1.cloudflare.com', 'ns2.cloudflare.com'],
        }),
      },
    ]);

    const zone = await createCloudflareZone('tok', 'acct_1', 'example.com');

    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toContain('/zones');
    expect(calls[0]!.body).toEqual({
      name: 'example.com',
      account: { id: 'acct_1' },
      type: 'full',
    });
    expect(zone).toEqual({
      zoneId: 'zone_1',
      nameservers: ['ns1.cloudflare.com', 'ns2.cloudflare.com'],
      status: 'pending',
    });
  });

  it('falls back to a non-active status when Cloudflare omits one', async () => {
    // Zone.status is optional in the API. Callers compare it against 'active',
    // so an absent status must not read as active.
    withResponses([{ body: ok({ id: 'zone_1', name: 'example.com', name_servers: [] }) }]);

    const zone = await createCloudflareZone('tok', 'acct_1', 'example.com');

    expect(zone.status).toBe('pending');
  });

  it('finds a zone id by name', async () => {
    const calls = withResponses([{ body: ok([{ id: 'zone_1', name: 'weldmail.com' }]) }]);

    await expect(findZoneIdByName('tok', 'weldmail.com')).resolves.toBe('zone_1');
    expect(calls[0]!.url).toContain('name=weldmail.com');
  });

  it('returns null when no zone matches', async () => {
    withResponses([{ body: ok([]) }]);
    await expect(findZoneIdByName('tok', 'nope.com')).resolves.toBeNull();
  });

  it('classifies a domain already held by another Cloudflare account', async () => {
    withResponses([
      {
        status: 400,
        body: { success: false, errors: [{ code: 1061, message: 'already exists' }], result: null },
      },
    ]);

    const err = (await createCloudflareZone('tok', 'acct_1', 'taken.com').catch(
      (e: unknown) => e,
    )) as CloudflareZoneError;

    expect(err).toBeInstanceOf(CloudflareZoneError);
    expect(err.kind).toBe('DOMAIN_IN_ANOTHER_CF_ACCOUNT');
  });

  it('classifies an auth failure', async () => {
    withResponses([
      {
        status: 403,
        body: { success: false, errors: [{ code: 10000, message: 'denied' }], result: null },
      },
    ]);

    const err = (await createCloudflareZone('tok', 'acct_1', 'example.com').catch(
      (e: unknown) => e,
    )) as CloudflareZoneError;

    expect(err.kind).toBe('AUTH_FAILED');
  });

  it('reports a missing zone as null rather than throwing', async () => {
    withResponses([
      {
        status: 404,
        body: { success: false, errors: [{ code: 7003, message: 'not found' }], result: null },
      },
    ]);

    await expect(getCloudflareZone('tok', 'gone')).resolves.toBeNull();
  });
});

describe('DNS records', () => {
  const created = (over: Record<string, unknown>) =>
    ok({ id: 'rec_1', name: 'example.com', ttl: 3600, ...over });

  it('sends content for a simple record type', async () => {
    const calls = withResponses([{ body: created({ type: 'A', content: '1.2.3.4' }) }]);

    const result = await createDnsRecordInZone('tok', 'zone_1', {
      type: 'A',
      name: 'example.com',
      content: '1.2.3.4',
    });

    expect(calls[0]!.url).toContain('/zones/zone_1/dns_records');
    expect(calls[0]!.body).toEqual({
      name: 'example.com',
      ttl: 3600,
      type: 'A',
      content: '1.2.3.4',
      proxied: false,
    });
    expect(result).toMatchObject({ created: true, duplicate: false });
    expect(result.record).toMatchObject({ id: 'rec_1', zone_id: 'zone_1', content: '1.2.3.4' });
  });

  it('sends MX priority alongside content', async () => {
    const calls = withResponses([
      { body: created({ type: 'MX', content: 'mx.example.com', priority: 10 }) },
    ]);

    await createDnsRecordInZone('tok', 'zone_1', {
      type: 'MX',
      name: 'example.com',
      content: 'mx.example.com',
      priority: 10,
    });

    expect(calls[0]!.body).toMatchObject({ type: 'MX', content: 'mx.example.com', priority: 10 });
  });

  // The migration's headline fix — Cloudflare rejects `content` on SRV.
  it('converts SRV content into the structured data object', async () => {
    const calls = withResponses([{ body: created({ type: 'SRV' }) }]);

    await createDnsRecordInZone('tok', 'zone_1', {
      type: 'SRV',
      name: '_sip._tcp.example.com',
      content: '10 60 5060 sipserver.example.com',
    });

    expect(calls[0]!.body).toEqual({
      name: '_sip._tcp.example.com',
      ttl: 3600,
      type: 'SRV',
      data: { priority: 10, weight: 60, port: 5060, target: 'sipserver.example.com' },
    });
    expect(calls[0]!.body).not.toHaveProperty('content');
  });

  it('lets an explicit priority win over the one embedded in SRV content', async () => {
    const calls = withResponses([{ body: created({ type: 'SRV' }) }]);

    await createDnsRecordInZone('tok', 'zone_1', {
      type: 'SRV',
      name: '_sip._tcp.example.com',
      content: '10 60 5060 sipserver.example.com',
      priority: 20,
    });

    expect(calls[0]!.body.data.priority).toBe(20);
  });

  // Same fix for CAA.
  it('converts CAA content into the structured data object', async () => {
    const calls = withResponses([{ body: created({ type: 'CAA' }) }]);

    await createDnsRecordInZone('tok', 'zone_1', {
      type: 'CAA',
      name: 'example.com',
      content: '0 issue "letsencrypt.org"',
    });

    expect(calls[0]!.body).toEqual({
      name: 'example.com',
      ttl: 3600,
      type: 'CAA',
      data: { flags: 0, tag: 'issue', value: 'letsencrypt.org' },
    });
  });

  it('reports a duplicate rather than throwing', async () => {
    withResponses([
      {
        status: 400,
        body: {
          success: false,
          errors: [{ code: 81057, message: 'Record already exists.' }],
          result: null,
        },
      },
    ]);

    await expect(
      createDnsRecordInZone('tok', 'zone_1', { type: 'A', name: 'a.example.com', content: '1.2.3.4' }),
    ).resolves.toEqual({ created: false, duplicate: true });
  });

  it('walks every page when listing records', async () => {
    const calls = withResponses([
      {
        body: ok(
          [{ id: 'rec_1', type: 'A', name: 'a.example.com', content: '1.2.3.4', ttl: 3600 }],
          { result_info: { page: 1, per_page: 100, count: 1, total_count: 1, total_pages: 1 } },
        ),
      },
    ]);

    const records = await listDnsRecordsInZone('tok', 'zone_1');

    expect(calls[0]!.url).toContain('per_page=100');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ id: 'rec_1', zone_id: 'zone_1', type: 'A' });
  });

  it('treats an already-deleted record as gone, not an error', async () => {
    withResponses([
      {
        status: 404,
        body: { success: false, errors: [{ code: 81044, message: 'Record not found' }], result: null },
      },
    ]);

    await expect(deleteDnsRecordInZone('tok', 'zone_1', 'rec_1')).resolves.toEqual({
      deleted: false,
      alreadyGone: true,
    });
  });
});
