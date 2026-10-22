/**
 * A stand-in for the slice of the Cloudflare v4 API this package calls, served
 * from a {@link SandboxStore} instead of api.cloudflare.com.
 *
 * It is an overlay, not a replacement: zone creation always lands in the
 * sandbox, a zone id starting with `sbx` is answered here, and everything else
 * passes through to the real `fetch`. Workers that also read the platform's
 * own zones (the WeldMail apex) keep reaching real Cloudflare for those.
 *
 * Errors use the codes `toZoneError` and the record helpers branch on, so
 * callers see the same failures they would see from Cloudflare.
 */

import type { ZonesFetch } from '../transport';
import type { SandboxRecord, SandboxStore, SandboxZone } from './store';

/** Sandbox zone ids: `sbx` + 29 hex chars. Real Cloudflare ids are 32 hex chars. */
export const SANDBOX_ZONE_ID_PREFIX = 'sbx';

export function isSandboxZoneId(zoneId: string | null | undefined): boolean {
  return typeof zoneId === 'string' && zoneId.startsWith(SANDBOX_ZONE_ID_PREFIX);
}

/** Handed out when no nameservers are configured. They resolve nowhere. */
export const DEFAULT_SANDBOX_NAMESERVERS = ['ns1.sandbox.weldhost.test', 'ns2.sandbox.weldhost.test'];

/** How long a new sandbox zone stays `pending`, standing in for NS delegation. */
export const DEFAULT_ACTIVATE_AFTER_MS = 60_000;

export interface SandboxFetchOptions {
  store: SandboxStore;
  /** Where non-sandbox calls go. Omit to answer them with a 404 instead (tests). */
  passthrough?: ZonesFetch;
  nameservers?: string[];
  activateAfterMs?: number;
  now?: () => Date;
}

const API_PREFIX = '/client/v4';
const DEFAULT_PER_PAGE = 100;

class SandboxError extends Error {
  constructor(
    readonly status: number,
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function ok(result: unknown, resultInfo?: Record<string, number>): Response {
  return json(200, {
    success: true,
    errors: [],
    messages: [],
    result,
    ...(resultInfo ? { result_info: resultInfo } : {}),
  });
}

function fail(err: SandboxError): Response {
  return json(err.status, {
    success: false,
    errors: [{ code: err.code, message: err.message }],
    messages: [],
    result: null,
  });
}

function hexId(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(Math.ceil(length / 2)));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, length);
}

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

function isRegistrableName(name: string): boolean {
  const labels = name.split('.');
  return labels.length >= 2 && labels.every((l) => LABEL.test(l)) && !/^\d+$/.test(labels.at(-1)!);
}

/** Cloudflare's own expansion: `@` is the apex, a relative name gets the zone appended. */
function qualifyName(name: string, zoneName: string): string {
  const n = name.trim().toLowerCase().replace(/\.$/, '');
  if (n === '' || n === '@') return zoneName;
  if (n === zoneName || n.endsWith(`.${zoneName}`)) return n;
  return `${n}.${zoneName}`;
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

interface RecordBody {
  type?: string;
  name?: string;
  content?: string;
  data?: Record<string, unknown>;
  priority?: number;
  ttl?: number;
  proxied?: boolean;
  comment?: string | null;
}

function validateRecord(body: RecordBody): void {
  if (!body.type || !body.name) {
    throw new SandboxError(400, 9000, 'DNS record type and name are required.');
  }
  if (body.type === 'A' && !IPV4.test(body.content ?? '')) {
    throw new SandboxError(400, 9005, 'Content for A record must be a valid IPv4 address.');
  }
  if (body.type === 'AAAA' && !(body.content ?? '').includes(':')) {
    throw new SandboxError(400, 9006, 'Content for AAAA record must be a valid IPv6 address.');
  }
  if ((body.type === 'SRV' || body.type === 'CAA') && !body.data) {
    throw new SandboxError(400, 9101, `${body.type} records require data.`);
  }
}

function sameRecord(a: SandboxRecord, b: SandboxRecord): boolean {
  return (
    a.type === b.type &&
    a.name === b.name &&
    (a.content ?? '') === (b.content ?? '') &&
    JSON.stringify(a.data ?? null) === JSON.stringify(b.data ?? null)
  );
}

/** Cloudflare's checks that matter to callers: exact duplicates and CNAME exclusivity. */
function assertNoConflict(existing: SandboxRecord[], next: SandboxRecord): void {
  const others = existing.filter((r) => r.id !== next.id);
  if (others.some((r) => sameRecord(r, next))) {
    throw new SandboxError(400, 81058, 'An identical record already exists.');
  }
  const atName = others.filter((r) => r.name === next.name);
  if (atName.length > 0 && (next.type === 'CNAME' || atName.some((r) => r.type === 'CNAME'))) {
    throw new SandboxError(400, 81053, 'A record with the same host already exists and conflicts with a CNAME.');
  }
}

function paginate<T>(items: T[], url: URL): { page: T[]; info: Record<string, number> } {
  const perPage = Math.max(1, Number(url.searchParams.get('per_page')) || DEFAULT_PER_PAGE);
  const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
  return {
    page: items.slice((page - 1) * perPage, page * perPage),
    info: {
      page,
      per_page: perPage,
      count: Math.max(0, Math.min(perPage, items.length - (page - 1) * perPage)),
      total_count: items.length,
      total_pages: Math.max(1, Math.ceil(items.length / perPage)),
    },
  };
}

async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new SandboxError(400, 6007, 'Malformed JSON in request body.');
  }
}

export function createSandboxZonesFetch(opts: SandboxFetchOptions): ZonesFetch {
  const { store } = opts;
  const nameservers = opts.nameservers?.length ? opts.nameservers : DEFAULT_SANDBOX_NAMESERVERS;
  const activateAfterMs = opts.activateAfterMs ?? DEFAULT_ACTIVATE_AFTER_MS;
  const now = opts.now ?? (() => new Date());

  const notFound = (): Response =>
    fail(new SandboxError(404, 7003, 'Could not route to /zones, perhaps your object identifier is invalid?'));

  const passthrough = (input: Parameters<ZonesFetch>[0], init: Parameters<ZonesFetch>[1]) =>
    opts.passthrough ? opts.passthrough(input, init) : Promise.resolve(notFound());

  /** `pending` until `activateAfterMs` has passed, then `active` (persisted). */
  async function settle(zone: SandboxZone): Promise<SandboxZone> {
    if (zone.status === 'active') return zone;
    const t = now();
    if (t.getTime() - Date.parse(zone.created_on) < activateAfterMs) return zone;
    const active: SandboxZone = { ...zone, status: 'active', activated_on: t.toISOString(), modified_on: t.toISOString() };
    await store.putZone(active);
    return active;
  }

  async function requireZone(id: string): Promise<SandboxZone> {
    const zone = await store.getZone(id);
    if (!zone) throw new SandboxError(404, 7003, 'Could not route to the zone, perhaps your object identifier is invalid?');
    return zone;
  }

  async function createZone(request: Request): Promise<Response> {
    const body = await readJson<{ name?: string; account?: { id?: string } }>(request);
    const name = (body.name ?? '').trim().toLowerCase().replace(/\.$/, '');
    if (!isRegistrableName(name)) {
      throw new SandboxError(400, 1049, `${body.name ?? ''} is not a registered domain`);
    }
    if (await store.findZoneByName(name)) {
      throw new SandboxError(400, 1061, `${name} already exists`);
    }
    const t = now().toISOString();
    const zone: SandboxZone = {
      id: `${SANDBOX_ZONE_ID_PREFIX}${hexId(29)}`,
      name,
      account: { id: body.account?.id ?? 'sandbox', name: 'WeldHost DNS sandbox' },
      status: 'pending',
      name_servers: nameservers,
      original_name_servers: null,
      type: 'full',
      paused: false,
      created_on: t,
      modified_on: t,
      activated_on: null,
    };
    await store.putZone(zone);
    return ok(zone);
  }

  async function buildRecord(zone: SandboxZone, body: RecordBody, previous?: SandboxRecord): Promise<SandboxRecord> {
    validateRecord(body);
    const t = now().toISOString();
    const record: SandboxRecord = {
      id: previous?.id ?? hexId(32),
      zone_id: zone.id,
      zone_name: zone.name,
      type: body.type!,
      name: qualifyName(body.name!, zone.name),
      ...(body.content !== undefined ? { content: body.content } : {}),
      ...(body.data ? { data: body.data } : {}),
      ...(body.priority !== undefined ? { priority: body.priority } : {}),
      ttl: body.ttl ?? 1,
      proxied: Boolean(body.proxied),
      proxiable: ['A', 'AAAA', 'CNAME'].includes(body.type!),
      comment: body.comment ?? null,
      tags: [],
      created_on: previous?.created_on ?? t,
      modified_on: t,
    };
    assertNoConflict(await store.listRecords(zone.id), record);
    await store.putRecord(record);
    return record;
  }

  const unsupported = (method: string, url: URL) =>
    new SandboxError(405, 10000, `${method} ${url.pathname} is not supported by the DNS sandbox.`);

  /** `/zones/:id` */
  async function handleZoneRoot(method: string, url: URL, zone: SandboxZone): Promise<Response> {
    if (method === 'GET') return ok(await settle(zone));
    if (method === 'DELETE') {
      await store.deleteZone(zone.id);
      return ok({ id: zone.id });
    }
    throw unsupported(method, url);
  }

  /** `/zones/:id/dns_records` */
  async function handleRecordList(request: Request, url: URL, zone: SandboxZone): Promise<Response> {
    const method = request.method.toUpperCase();
    if (method === 'GET') {
      const all = (await store.listRecords(zone.id)).sort((a, b) => a.created_on.localeCompare(b.created_on));
      const { page, info } = paginate(all, url);
      return ok(page, info);
    }
    if (method === 'POST') return ok(await buildRecord(zone, await readJson<RecordBody>(request)));
    throw unsupported(method, url);
  }

  /** `/zones/:id/dns_records/:recordId` */
  async function handleRecord(request: Request, url: URL, zone: SandboxZone, recordId: string): Promise<Response> {
    const method = request.method.toUpperCase();
    const existing = await store.getRecord(zone.id, recordId);
    if (!existing) throw new SandboxError(404, 81044, 'Record does not exist.');
    switch (method) {
      case 'GET':
        return ok(existing);
      case 'DELETE':
        await store.deleteRecord(zone.id, recordId);
        return ok({ id: recordId });
      case 'PUT':
        return ok(await buildRecord(zone, await readJson<RecordBody>(request), existing));
      case 'PATCH':
        return ok(await buildRecord(zone, { ...existing, ...(await readJson<RecordBody>(request)) }, existing));
      default:
        throw unsupported(method, url);
    }
  }

  async function handleZone(request: Request, url: URL, zoneId: string, rest: string[]): Promise<Response> {
    const zone = await requireZone(zoneId);
    if (rest.length === 0) return handleZoneRoot(request.method.toUpperCase(), url, zone);
    if (rest[0] === 'dns_records' && rest.length === 1) return handleRecordList(request, url, zone);
    if (rest[0] === 'dns_records' && rest.length === 2) return handleRecord(request, url, zone, rest[1]!);
    throw unsupported(request.method.toUpperCase(), url);
  }

  /** `GET /zones?name=`: names are unique, so a sandbox hit is the whole answer. */
  async function findZone(url: URL, name: string): Promise<Response | null> {
    const zone = await store.findZoneByName(name.trim().toLowerCase());
    if (zone) {
      const { page, info } = paginate([await settle(zone)], url);
      return ok(page, info);
    }
    return opts.passthrough ? null : ok([], paginate([], url).info);
  }

  /** `/zones`. `null` means "not ours": pass it through. */
  async function handleZones(request: Request, url: URL): Promise<Response | null> {
    const method = request.method.toUpperCase();
    if (method === 'POST') return createZone(request);
    const name = url.searchParams.get('name');
    return method === 'GET' && name ? findZone(url, name) : null;
  }

  async function route(request: Request, url: URL, segments: string[]): Promise<Response | null> {
    if (segments.length === 1) return handleZones(request, url);
    const zoneId = segments[1]!;
    return isSandboxZoneId(zoneId) ? handleZone(request, url, zoneId, segments.slice(2)) : null;
  }

  return async (input, init) => {
    const request = new Request(input as RequestInfo, init as RequestInit);
    const url = new URL(request.url);
    const path = url.pathname.startsWith(API_PREFIX) ? url.pathname.slice(API_PREFIX.length) : url.pathname;
    const segments = path.split('/').filter(Boolean);
    if (segments[0] !== 'zones') return passthrough(input, init);

    try {
      return (await route(request, url, segments)) ?? (await passthrough(input, init));
    } catch (err) {
      if (err instanceof SandboxError) return fail(err);
      throw err;
    }
  };
}
