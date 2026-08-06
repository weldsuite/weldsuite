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
    /**
     * The HTTP status, kept as a field so callers can branch on it. It also
     * appears in `message`, but matching that string would couple every caller
     * to the wording below.
     */
    public readonly status?: number,
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
      err.status,
    );
  }
  if (err.status === 401 || err.status === 403) {
    return new CloudflareZoneError(
      'AUTH_FAILED',
      'Cloudflare API token is missing or lacks the required scope',
      cfErrors,
      err.status,
    );
  }
  if (codes.includes(1049) || codes.includes(1097)) {
    return new CloudflareZoneError(
      'INVALID_DOMAIN',
      first ?? 'Invalid domain',
      cfErrors,
      err.status,
    );
  }
  return new CloudflareZoneError(
    'UNKNOWN',
    `Cloudflare API error ${err.status ?? '(no status)'}: ${first ?? err.message ?? 'unknown'}`,
    cfErrors,
    err.status,
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
  // maxRetries: 0 — zone creation is not idempotent. The SDK retries 408/409/429
  // and 5xx by default, so a dropped response on a create that actually
  // succeeded would be replayed and come back as "already exists" (code 1061),
  // which `toZoneError` maps to DOMAIN_IN_ANOTHER_CF_ACCOUNT — telling the
  // customer their domain is taken when we had just created it ourselves. One
  // attempt; a genuine transient failure surfaces to the caller instead.
  const zone = await zoneCall(() =>
    client(apiToken).zones.create(
      { name: domain, account: { id: accountId }, type: 'full' },
      { maxRetries: 0 },
    ),
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
      if (err.status === 404) return null;
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
  /**
   * `null` for record types this module cannot edit — a zone contains types
   * outside {@link DnsRecordType} (SOA, HTTPS, SVCB, PTR, …) and
   * {@link listDnsRecordsInZone} returns all of them. Callers must not feed a
   * record with a null type back into {@link updateDnsRecordInZone}: it would
   * fall through the simple-content branch and rewrite the record wrongly.
   */
  type: DnsRecordType | null;
  /** Raw type string as Cloudflare reported it, even when `type` is null. */
  rawType: string;
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

const EDITABLE_RECORD_TYPES = new Set<string>([
  'A', 'AAAA', 'CNAME', 'MX', 'TXT', 'CAA', 'SRV', 'NS',
]);

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
 * True when `content` is already one or more RFC 1035 quoted character-strings
 * (e.g. `"v=spf1 …"` or `"chunk1" "chunk2"`).
 */
function isQuotedTxtContent(content: string): boolean {
  return /^("(?:[^"\\]|\\.)*")(?:\s+"(?:[^"\\]|\\.)*")*$/.test(content);
}

/**
 * Cloudflare expects TXT `content` as quoted character-strings. Unquoted
 * values still work (CF may quote them on behalf of the caller) but surface a
 * dashboard warning — wrap on the way out so records are stored in the
 * preferred form. Already-quoted input is left alone to avoid double-quoting
 * on edit round-trips. Leading/trailing spaces are part of the TXT payload and
 * must not be trimmed when quoting.
 */
function quoteTxtContent(content: string): string {
  if (content === '') return '""';
  // Allow incidental whitespace around an already-quoted payload, but never
  // strip spaces that are themselves the record value.
  const trimmed = content.trim();
  if (isQuotedTxtContent(trimmed)) return trimmed;
  return `"${content.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Inverse of {@link quoteTxtContent} for display / local storage: strip the
 * RFC quoting Cloudflare returns (and that we send) so the UI shows the bare
 * value users type. Multi-string payloads are concatenated. Spaces inside the
 * quoted strings are preserved.
 */
function unwrapTxtContent(content: string): string {
  const trimmed = content.trim();
  if (!isQuotedTxtContent(trimmed)) return content;
  return [...trimmed.matchAll(/"((?:[^"\\]|\\.)*)"/g)]
    .map((m) => m[1]!.replace(/\\"/g, '"').replace(/\\\\/g, '\\'))
    .join('');
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
    case 'TXT':
      return {
        ...base,
        type: 'TXT',
        content: quoteTxtContent(record.content),
        proxied: false,
      };
    default:
      return { ...base, type: record.type, content: record.content, proxied: false };
  }
}

/**
 * SRV and CAA carry no flat `content` on the wire — only `data` — so rebuild
 * the zone-file string callers display and diff against. Inverse of
 * {@link parseSrvContent} / {@link parseCaaContent}.
 */
function contentFromData(type: string, data: CloudflareDnsRecord['data']): string | undefined {
  if (!data) return undefined;
  if (type === 'SRV') {
    const { priority, weight, port, value } = data;
    const target = value ?? (data as { target?: string }).target;
    if ([priority, weight, port, target].some((v) => v === undefined)) return undefined;
    return `${priority} ${weight} ${port} ${target}`;
  }
  if (type === 'CAA') {
    const { flags, tag, value } = data;
    if ([flags, tag, value].some((v) => v === undefined)) return undefined;
    return `${flags} ${tag} "${value}"`;
  }
  return undefined;
}

/**
 * Flatten the SDK's discriminated response back into the shape callers already
 * consume. `zone_id` is not on the response — it is the zone we just addressed.
 */
function toDnsRecord(zoneId: string, r: RecordResponse): CloudflareDnsRecord {
  const withData = r as { data?: CloudflareDnsRecord['data'] };
  const withContent = r as { content?: string };
  const withPriority = r as { priority?: number };
  const rawType = String(r.type);
  const rawContent = withContent.content ?? contentFromData(rawType, withData.data) ?? '';
  return {
    id: r.id,
    zone_id: zoneId,
    type: EDITABLE_RECORD_TYPES.has(rawType) ? (rawType as DnsRecordType) : null,
    rawType,
    name: r.name,
    // Strip Cloudflare's TXT quoting so local storage / UI match what users type.
    content: rawType === 'TXT' ? unwrapTxtContent(rawContent) : rawContent,
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
