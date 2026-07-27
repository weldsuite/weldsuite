/**
 * Cloudflare Zones + DNS records helper (shared).
 *
 * Creates and manages DNS zones in our Cloudflare account for customer
 * domains. Returns the nameservers Cloudflare assigns so the customer can
 * point their registrar at them.
 *
 * Lives in a package rather than inside app-api because workspace-worker needs
 * {@link findZoneIdByName} too, and used to carry its own copy of it.
 *
 * Backed by the official `cloudflare` SDK (via `cloudflare/tree-shakable`, so
 * only the zones + DNS resources are bundled) rather than hand-written paths
 * and payloads. That change fixed a real defect: SRV and CAA records were being
 * posted with a flat `content` string, but Cloudflare takes a structured `data`
 * object for both — the SDK's discriminated union makes that a compile error
 * instead of a silent rejection at the registry.
 *
 * SDK: https://github.com/cloudflare/cloudflare-typescript
 */

import { createClient } from 'cloudflare/tree-shakable';
import { APIError } from 'cloudflare/core/error';
import { BaseZones } from 'cloudflare/resources/zones/zones';
import { Records } from 'cloudflare/resources/dns/records';
import type { RecordCreateParams, RecordResponse } from 'cloudflare/resources/dns/records';
import type { ClientOptions } from 'cloudflare/client';

export class CloudflareZoneError extends Error {
  constructor(
    public readonly kind:
      | 'DOMAIN_IN_ANOTHER_CF_ACCOUNT'
      | 'AUTH_FAILED'
      | 'INVALID_DOMAIN'
      | 'UNKNOWN',
    message: string,
    public readonly cfErrors?: { code: number; message: string }[],
  ) {
    super(message);
    this.name = 'CloudflareZoneError';
  }
}

/**
 * Cloudflare types `Zone.status` as optional. Callers compare it against
 * `'active'`, so an absent status has to fall back to something that is
 * explicitly not active — `pending` is what a freshly created zone reports
 * while it waits on nameserver delegation.
 */
const PENDING_ZONE_STATUS = 'pending';

/** The SDK's `fetch` signature, exported so tests can type their stub. */
export type ZonesFetch = NonNullable<ClientOptions['fetch']>;

/**
 * Tests set this to intercept the SDK's transport. The SDK holds its own
 * `fetch` reference, so patching `globalThis.fetch` does not reach it and a
 * test that tries would hit api.cloudflare.com for real. Never set in
 * production — every exported function takes only an `apiToken`, so there is
 * no per-call seam to thread through.
 */
let testFetch: ZonesFetch | undefined;

/** @internal Test-only. Pass `undefined` to restore the real transport. */
export function __setZonesFetchForTests(fetch: ZonesFetch | undefined): void {
  testFetch = fetch;
}

function client(apiToken: string) {
  return createClient({
    apiToken,
    maxRetries: 2,
    timeout: 15_000,
    ...(testFetch ? { fetch: testFetch } : {}),
    resources: [BaseZones, Records],
  });
}

/**
 * Classify an SDK failure into the kinds callers already branch on. The code
 * list is unchanged from the hand-rolled client; only the source of the codes
 * moved.
 */
function toZoneError(err: unknown): CloudflareZoneError {
  if (!(err instanceof APIError)) {
    return new CloudflareZoneError(
      'UNKNOWN',
      err instanceof Error ? err.message : String(err),
    );
  }
  const cfErrors = (err.errors ?? []).map((e) => ({
    code: Number(e.code ?? 0),
    message: String(e.message ?? ''),
  }));
  const codes = cfErrors.map((e) => e.code);
  const first = cfErrors[0]?.message;

  if (codes.includes(1061) || codes.includes(1100)) {
    return new CloudflareZoneError(
      'DOMAIN_IN_ANOTHER_CF_ACCOUNT',
      first ?? 'Domain is already in use on Cloudflare',
      cfErrors,
    );
  }
  if (err.status === 401 || err.status === 403) {
    return new CloudflareZoneError(
      'AUTH_FAILED',
      'Cloudflare API token is missing or lacks the required scope',
      cfErrors,
    );
  }
  if (codes.includes(1049) || codes.includes(1097)) {
    return new CloudflareZoneError('INVALID_DOMAIN', first ?? 'Invalid domain', cfErrors);
  }
  return new CloudflareZoneError(
    'UNKNOWN',
    `Cloudflare API error ${err.status ?? '(no status)'}: ${first ?? err.message ?? 'unknown'}`,
    cfErrors,
  );
}

async function zoneCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toZoneError(err);
  }
}

export async function createCloudflareZone(
  apiToken: string,
  accountId: string,
  domain: string,
): Promise<{ zoneId: string; nameservers: string[]; status: string }> {
  const zone = await zoneCall(() =>
    client(apiToken).zones.create({ name: domain, account: { id: accountId }, type: 'full' }),
  );
  return {
    zoneId: zone.id,
    nameservers: zone.name_servers ?? [],
    status: zone.status ?? PENDING_ZONE_STATUS,
  };
}

export async function getCloudflareZone(
  apiToken: string,
  zoneId: string,
): Promise<{ zoneId: string; nameservers: string[]; status: string } | null> {
  try {
    const zone = await zoneCall(() => client(apiToken).zones.get({ zone_id: zoneId }));
    return {
      zoneId: zone.id,
      nameservers: zone.name_servers ?? [],
      status: zone.status ?? PENDING_ZONE_STATUS,
    };
  } catch (err) {
    if (err instanceof CloudflareZoneError && err.kind === 'UNKNOWN') {
      if (err.cfErrors?.some((e) => e.code === 1001 || e.code === 7003)) return null;
      if (err.message.includes('Cloudflare API error 404')) return null;
    }
    throw err;
  }
}

export async function findZoneIdByName(
  apiToken: string,
  domain: string,
): Promise<string | null> {
  const page = await zoneCall(() => client(apiToken).zones.list({ name: domain }));
  return page.result?.[0]?.id ?? null;
}

export async function deleteCloudflareZone(apiToken: string, zoneId: string): Promise<void> {
  try {
    await zoneCall(() => client(apiToken).zones.delete({ zone_id: zoneId }));
  } catch (err) {
    console.error('[CloudflareZones] Rollback delete failed for zone', zoneId, err);
  }
}

// ============================================================================
// DNS records
// ============================================================================

export interface CreateDnsRecordInput {
  type: 'A' | 'AAAA' | 'CNAME' | 'MX' | 'TXT' | 'CAA' | 'SRV' | 'NS';
  name: string;
  content: string;
  ttl?: number;
  priority?: number;
  comment?: string;
}

export type DnsRecordType = CreateDnsRecordInput['type'];

export interface CloudflareDnsRecord {
  id: string;
  zone_id: string;
  type: DnsRecordType;
  name: string;
  content: string;
  ttl: number;
  priority?: number;
  proxied?: boolean;
  comment?: string | null;
  data?: {
    weight?: number;
    port?: number;
    priority?: number;
    flags?: number;
    tag?: string;
    value?: string;
  };
}

/**
 * SRV content in zone-file form: `<priority> <weight> <port> <target>`.
 * An explicit `priority` on the input wins over the one embedded in the string.
 */
function parseSrvContent(content: string, priority: number | undefined) {
  const [p, weight, port, ...target] = content.trim().split(/\s+/);
  return {
    priority: priority ?? Number(p),
    weight: Number(weight),
    port: Number(port),
    target: target.join(' ') || undefined,
  };
}

/** CAA content in zone-file form: `<flags> <tag> "<value>"`. */
function parseCaaContent(content: string) {
  const [flags, tag, ...value] = content.trim().split(/\s+/);
  return {
    flags: Number(flags),
    tag,
    value: value.join(' ').replace(/^"|"$/g, '') || undefined,
  };
}

/**
 * Translate our flat record input into the SDK's per-type parameter union.
 * Cloudflare accepts `content` for A/AAAA/CNAME/MX/TXT/NS but requires a
 * structured `data` object for SRV and CAA.
 */
function toCreateParams(
  zoneId: string,
  record: CreateDnsRecordInput,
): RecordCreateParams {
  const base = {
    zone_id: zoneId,
    name: record.name,
    ttl: record.ttl ?? 3600,
    ...(record.comment ? { comment: record.comment } : {}),
  };

  switch (record.type) {
    case 'SRV':
      return { ...base, type: 'SRV', data: parseSrvContent(record.content, record.priority) };
    case 'CAA':
      return { ...base, type: 'CAA', data: parseCaaContent(record.content) };
    case 'MX':
      return {
        ...base,
        type: 'MX',
        content: record.content,
        priority: record.priority ?? 0,
        proxied: false,
      };
    case 'NS':
      return { ...base, type: 'NS', content: record.content };
    default:
      return { ...base, type: record.type, content: record.content, proxied: false };
  }
}

/**
 * Flatten the SDK's discriminated response back into the shape callers already
 * consume. `zone_id` is not on the response — it is the zone we just addressed.
 */
function toDnsRecord(zoneId: string, r: RecordResponse): CloudflareDnsRecord {
  const withData = r as { data?: CloudflareDnsRecord['data'] };
  const withContent = r as { content?: string };
  const withPriority = r as { priority?: number };
  return {
    id: r.id,
    zone_id: zoneId,
    type: r.type as DnsRecordType,
    name: r.name,
    content: withContent.content ?? '',
    ttl: typeof r.ttl === 'number' ? r.ttl : 1,
    priority: withPriority.priority,
    proxied: r.proxied,
    comment: r.comment ?? null,
    data: withData.data,
  };
}

export async function createDnsRecordInZone(
  apiToken: string,
  zoneId: string,
  record: CreateDnsRecordInput,
): Promise<{ created: boolean; duplicate: boolean; record?: CloudflareDnsRecord }> {
  try {
    const created = await zoneCall(() =>
      client(apiToken).dns.records.create(toCreateParams(zoneId, record)),
    );
    return { created: true, duplicate: false, record: toDnsRecord(zoneId, created) };
  } catch (err) {
    if (err instanceof CloudflareZoneError) {
      if (err.cfErrors?.some((e) => e.code === 81057 || e.code === 81058)) {
        return { created: false, duplicate: true };
      }
      if (err.message.includes('81057')) return { created: false, duplicate: true };
    }
    throw err;
  }
}

export async function listDnsRecordsInZone(
  apiToken: string,
  zoneId: string,
): Promise<CloudflareDnsRecord[]> {
  return zoneCall(async () => {
    const out: CloudflareDnsRecord[] = [];
    // The SDK walks the V4 page cursor itself — this used to be a hand-rolled
    // `page`/`total_pages` loop.
    const page = await client(apiToken).dns.records.list({ zone_id: zoneId, per_page: 100 });
    for await (const record of page) out.push(toDnsRecord(zoneId, record));
    return out;
  });
}

export async function updateDnsRecordInZone(
  apiToken: string,
  zoneId: string,
  recordId: string,
  record: CreateDnsRecordInput,
): Promise<CloudflareDnsRecord> {
  const updated = await zoneCall(() =>
    client(apiToken).dns.records.update(recordId, toCreateParams(zoneId, record)),
  );
  return toDnsRecord(zoneId, updated);
}

export async function deleteDnsRecordInZone(
  apiToken: string,
  zoneId: string,
  recordId: string,
): Promise<{ deleted: boolean; alreadyGone: boolean }> {
  try {
    await zoneCall(() => client(apiToken).dns.records.delete(recordId, { zone_id: zoneId }));
    return { deleted: true, alreadyGone: false };
  } catch (err) {
    if (
      err instanceof CloudflareZoneError &&
      err.cfErrors?.some((e) => e.code === 81044 || e.code === 7003)
    ) {
      return { deleted: false, alreadyGone: true };
    }
    throw err;
  }
}
