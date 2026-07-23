/**
 * Cloudflare Zones API helper.
 *
 * Creates and manages DNS zones in our Cloudflare account for customer
 * domains. Returns the nameservers Cloudflare assigns so the customer can
 * point their registrar at them.
 */

const CF_API_BASE = 'https://api.cloudflare.com/client/v4';

interface CloudflareApiResponse<T = unknown> {
  success: boolean;
  errors: { code: number; message: string }[];
  result: T;
}

interface CloudflareZone {
  id: string;
  name: string;
  status: string;
  name_servers: string[];
}

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

async function cfFetch<T>(
  apiToken: string,
  path: string,
  options: RequestInit = {},
): Promise<CloudflareApiResponse<T>> {
  const res = await fetch(`${CF_API_BASE}${path}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  const body = (await res.json()) as CloudflareApiResponse<T>;
  if (!res.ok || !body.success) {
    const codes = body.errors?.map((e) => e.code) ?? [];
    if (codes.includes(1061) || codes.includes(1100)) {
      throw new CloudflareZoneError(
        'DOMAIN_IN_ANOTHER_CF_ACCOUNT',
        body.errors?.[0]?.message ?? 'Domain is already in use on Cloudflare',
        body.errors,
      );
    }
    if (res.status === 401 || res.status === 403) {
      throw new CloudflareZoneError(
        'AUTH_FAILED',
        'Cloudflare API token is missing or lacks the required scope',
        body.errors,
      );
    }
    if (codes.includes(1049) || codes.includes(1097)) {
      throw new CloudflareZoneError(
        'INVALID_DOMAIN',
        body.errors?.[0]?.message ?? 'Invalid domain',
        body.errors,
      );
    }
    throw new CloudflareZoneError(
      'UNKNOWN',
      `Cloudflare API error ${res.status}: ${body.errors?.[0]?.message ?? 'unknown'}`,
      body.errors,
    );
  }
  return body;
}

export async function createCloudflareZone(
  apiToken: string,
  accountId: string,
  domain: string,
): Promise<{ zoneId: string; nameservers: string[]; status: string }> {
  const body = await cfFetch<CloudflareZone>(apiToken, '/zones', {
    method: 'POST',
    body: JSON.stringify({
      name: domain,
      account: { id: accountId },
      type: 'full',
    }),
  });

  const zone = body.result;
  return {
    zoneId: zone.id,
    nameservers: zone.name_servers ?? [],
    status: zone.status,
  };
}

export async function getCloudflareZone(
  apiToken: string,
  zoneId: string,
): Promise<{ zoneId: string; nameservers: string[]; status: string } | null> {
  try {
    const body = await cfFetch<CloudflareZone>(apiToken, `/zones/${zoneId}`, { method: 'GET' });
    return {
      zoneId: body.result.id,
      nameservers: body.result.name_servers ?? [],
      status: body.result.status,
    };
  } catch (err) {
    if (err instanceof CloudflareZoneError && err.kind === 'UNKNOWN') {
      if (err.cfErrors?.some((e) => e.code === 1001 || e.code === 7003)) return null;
    }
    throw err;
  }
}

export async function findZoneIdByName(
  apiToken: string,
  domain: string,
): Promise<string | null> {
  const body = await cfFetch<CloudflareZone[]>(
    apiToken,
    `/zones?name=${encodeURIComponent(domain)}`,
    { method: 'GET' },
  );
  return body.result?.[0]?.id ?? null;
}

export async function deleteCloudflareZone(apiToken: string, zoneId: string): Promise<void> {
  try {
    await cfFetch<unknown>(apiToken, `/zones/${zoneId}`, { method: 'DELETE' });
  } catch (err) {
    console.error('[CloudflareZones] Rollback delete failed for zone', zoneId, err);
  }
}

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

export async function createDnsRecordInZone(
  apiToken: string,
  zoneId: string,
  record: CreateDnsRecordInput,
): Promise<{ created: boolean; duplicate: boolean; record?: CloudflareDnsRecord }> {
  const body: Record<string, unknown> = {
    type: record.type,
    name: record.name,
    content: record.content,
    ttl: record.ttl ?? 3600,
    proxied: false,
  };
  if (record.type === 'MX' || record.type === 'SRV') {
    body.priority = record.priority ?? 0;
  }
  if (record.comment) body.comment = record.comment;

  try {
    const res = await cfFetch<CloudflareDnsRecord>(apiToken, `/zones/${zoneId}/dns_records`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return { created: true, duplicate: false, record: res.result };
  } catch (err) {
    if (err instanceof CloudflareZoneError) {
      if (err.cfErrors?.some((e) => e.code === 81057 || e.code === 81058)) {
        return { created: false, duplicate: true };
      }
    } else if (err instanceof Error && err.message.includes('81057')) {
      return { created: false, duplicate: true };
    }
    throw err;
  }
}

export async function listDnsRecordsInZone(
  apiToken: string,
  zoneId: string,
): Promise<CloudflareDnsRecord[]> {
  const perPage = 100;
  const all: CloudflareDnsRecord[] = [];
  let page = 1;
  while (true) {
    const res = await fetch(
      `${CF_API_BASE}/zones/${zoneId}/dns_records?per_page=${perPage}&page=${page}`,
      {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiToken}`,
          'Content-Type': 'application/json',
        },
      },
    );
    const body = (await res.json()) as CloudflareApiResponse<CloudflareDnsRecord[]> & {
      result_info?: { page: number; total_pages: number; count: number; total_count: number };
    };
    if (!res.ok || !body.success) {
      throw new CloudflareZoneError(
        res.status === 401 || res.status === 403 ? 'AUTH_FAILED' : 'UNKNOWN',
        `Cloudflare list records failed (${res.status}): ${body.errors?.[0]?.message ?? 'unknown'}`,
        body.errors,
      );
    }
    all.push(...(body.result ?? []));
    const totalPages = body.result_info?.total_pages ?? 1;
    if (page >= totalPages) break;
    page++;
  }
  return all;
}

export async function updateDnsRecordInZone(
  apiToken: string,
  zoneId: string,
  recordId: string,
  record: CreateDnsRecordInput,
): Promise<CloudflareDnsRecord> {
  const body: Record<string, unknown> = {
    type: record.type,
    name: record.name,
    content: record.content,
    ttl: record.ttl ?? 3600,
    proxied: false,
  };
  if (record.type === 'MX' || record.type === 'SRV') {
    body.priority = record.priority ?? 0;
  }
  if (record.comment !== undefined) body.comment = record.comment;

  const res = await cfFetch<CloudflareDnsRecord>(
    apiToken,
    `/zones/${zoneId}/dns_records/${recordId}`,
    {
      method: 'PUT',
      body: JSON.stringify(body),
    },
  );
  return res.result;
}

export async function deleteDnsRecordInZone(
  apiToken: string,
  zoneId: string,
  recordId: string,
): Promise<{ deleted: boolean; alreadyGone: boolean }> {
  try {
    await cfFetch<unknown>(apiToken, `/zones/${zoneId}/dns_records/${recordId}`, {
      method: 'DELETE',
    });
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
