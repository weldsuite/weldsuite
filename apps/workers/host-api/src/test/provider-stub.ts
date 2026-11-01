/**
 * Stand-ins for the providers host-api calls: Realtime Register's REST API
 * and its ADAC checker, Cloudflare's API (zones, DNS records, the legacy
 * registrar) and Cloudflare's DNS-over-HTTPS resolver. Every answer depends
 * on the method, URL and body only, never on call order, so the same stub
 * answers both backends in conformance mode (the Rust server's calls reach
 * it through the harness's outbound bridge). Install it with
 * `vi.stubGlobal('fetch', createProviderFetchStub())`; every other URL (the
 * harness's own loopback calls) goes to the real fetch.
 *
 * Names steer the answers: a domain whose name contains `taken` is
 * registered by someone else, `boom` makes the registrar fail, `denied`
 * answers 401, and so on (see each handler).
 */

import { vi } from 'vitest';

export const RTR = 'https://api.yoursrs.com/v2/';
export const RTR_OTE = 'https://api.yoursrs-ote.com/v2/';
export const ADAC = 'https://adac.api.yoursrs.com/action';
export const CF = 'https://api.cloudflare.com/client/v4';
export const DOH = 'https://cloudflare-dns.com/dns-query';

/** The env that turns Realtime Register on (live API, with ADAC). */
export const RTR_ENV = {
  REALTIME_REGISTER_API_KEY: 'rtr-key',
  REALTIME_REGISTER_CUSTOMER: 'weldsuite',
  REALTIME_REGISTER_ADAC_API_KEY: 'adac-key',
  REALTIME_REGISTER_CONTACT_ADMIN: 'ws-admin',
  REALTIME_REGISTER_CONTACT_TECH: 'ws-tech',
};

/** The env that turns Cloudflare on (zones, DNS records, the legacy registrar). */
export const CF_ENV = { CLOUDFLARE_API_TOKEN: 'cf-token', CLOUDFLARE_ACCOUNT_ID: 'cf-account' };

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const cf = (result: unknown) => json({ success: true, errors: [], messages: [], result });
const cfError = (status: number, code: number, message: string) =>
  json({ success: false, errors: [{ code, message }], messages: [], result: null }, status);

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

function bodyOf(init?: RequestInit): Record<string, unknown> {
  if (typeof init?.body !== 'string' || init.body === '') return {};
  try {
    return JSON.parse(init.body) as Record<string, unknown>;
  } catch {
    return {};
  }
}

// ── Realtime Register ───────────────────────────────────────────────────────

/** `GET processes/{id}`: the status by id. */
const PROCESSES: Record<string, string> = {
  '1001': 'COMPLETED',
  '1002': 'RUNNING',
  '1003': 'FAILED',
  '9001': 'RUNNING',
};

function rtrDomain(name: string): Response {
  if (name.includes('denied')) return json({ type: 'AuthenticationFailed', message: 'Bad key' }, 401);
  if (name.includes('boom')) return json({ message: 'Upstream exploded' }, 500);
  if (name.includes('missing')) return json({ type: 'ObjectDoesNotExist', message: `Domain ${name} not found` }, 404);
  return json({
    domainName: name,
    status: name.includes('unlocked') ? ['OK'] : ['OK', 'CLIENT_TRANSFER_PROHIBITED'],
    expiryDate: '2027-05-01T10:00:00Z',
    autoRenew: false,
    privacyProtect: !name.includes('public'),
    ...(name.includes('withcode') ? { authcode: 'EPP-WITH-CODE' } : {}),
  });
}

function rtrCheck(name: string): Response {
  if (name.includes('boom')) return json({ message: 'Check failed' }, 500);
  if (name.includes('taken')) return json({ available: false, reason: 'domain_unavailable' });
  if (name.includes('premium')) return json({ available: true, premium: true, price: 125000, currency: 'USD' });
  return json({ available: true, premium: false, currency: 'USD' });
}

function rtrTransfer(name: string, body: Record<string, unknown>): Response {
  if (name.includes('refused')) return json({ type: 'InvalidAuthCode', message: 'The auth code is wrong' }, 422);
  if (name.includes('noprivacy') && body.privacyProtect === true) {
    return json({ type: 'InvalidParameter', message: 'Privacy protect is not supported for this registry' }, 400);
  }
  return json({ domainName: name, status: 'pendingfoa', processId: 9001, type: 'IN' });
}

function realtimeRegister(method: string, path: string, url: URL, body: Record<string, unknown>): Response {
  const segments = path.split('/').map(decodeURIComponent);
  if (segments[0] === 'processes' && method === 'GET') {
    const status = PROCESSES[segments[1]!];
    return status ? json({ id: Number(segments[1]), status }) : json({ message: 'No such process' }, 404);
  }
  if (segments[0] !== 'domains') return json({ message: 'Not found' }, 404);
  const name = segments[1]!;
  const action = segments[2];
  if (method === 'GET' && action === undefined) return rtrDomain(name);
  if (method === 'GET' && action === 'check') return rtrCheck(name);
  if (method === 'GET' && action === 'info' && url.searchParams.get('type') === 'AUTHCODE') {
    return name.includes('infocode') ? json({ authcode: 'EPP-FROM-INFO' }) : json({ message: 'Unsupported' }, 404);
  }
  if (method === 'POST' && action === 'update') {
    if (name.includes('locked-out')) return json({ type: 'InvalidParameter', message: 'Status change refused' }, 400);
    return name.includes('async') ? json({}, 202, { 'x-process-id': '1002' }) : json({});
  }
  if (method === 'POST' && action === 'transfer') return rtrTransfer(name, body);
  return json({ message: 'Not found' }, 404);
}

/** ADAC: `input` expands the typed name over a TLD set, `check` answers one name. */
function adac(body: Record<string, unknown>): Response {
  const data = (body.data ?? {}) as { input?: string };
  const input = String(data.input ?? '');
  if (input.includes('adacerror')) return json([{ action: 'error', data: 'Rate limited' }]);
  if (input.includes('adacdown')) return json({ message: 'ADAC is down' }, 503);
  const status = (name: string) => (name.includes('taken') ? 2 : name.includes('broken') ? 4 : 1);
  const event = (name: string) => ({
    action: 'domain_status',
    data: {
      domain_name: name,
      suffix: name.split('.').slice(1).join('.'),
      status: status(name),
      ...(name.includes('premium') ? { type: 'premium', price: 99000, currency: 'USD' } : {}),
    },
  });
  if (body.action === 'check') return json([{ action: 'domain_status', data: { domain_name: input, status: 0 } }, event(input)]);
  const sld = input.split('.')[0]!;
  const names = [`${sld}.com`, `${sld}.net`, `${sld}.org`, `${sld}.io`, `get${sld}.com`];
  return json([...names.map(event), { action: 'done', data: 'complete' }]);
}

// ── Cloudflare ──────────────────────────────────────────────────────────────

/** Records per Cloudflare zone id. */
const ZONE_RECORDS: Record<string, unknown[]> = {
  cfz_live: [
    { id: 'cfr_a', type: 'A', name: 'live-site.com', content: '203.0.113.10', ttl: 300, proxied: false, comment: null },
    { id: 'cfr_mx', type: 'MX', name: 'live-site.com', content: 'mx.live-site.com', ttl: 3600, priority: 10 },
    { id: 'cfr_txt', type: 'TXT', name: 'live-site.com', content: '"v=spf1 include:mail.example -all"', ttl: 1 },
    { id: 'cfr_srv', type: 'SRV', name: '_sip._tcp.live-site.com', ttl: 3600, data: { priority: 10, weight: 5, port: 5060, target: 'sip.live-site.com' } },
    { id: 'cfr_caa', type: 'CAA', name: 'live-site.com', ttl: 3600, data: { flags: 0, tag: 'issue', value: 'letsencrypt.org' } },
    { id: 'cfr_soa', type: 'SOA', name: 'live-site.com', content: 'ns.cloudflare.com', ttl: 3600 },
  ],
};

function cloudflareZones(method: string, segments: string[], body: Record<string, unknown>, url: URL): Response {
  const zoneId = segments[1];
  if (zoneId === undefined) {
    if (method !== 'POST') return cfError(404, 7003, 'Not found');
    const name = String(body.name ?? '');
    if (name.includes('taken')) return cfError(400, 1061, `${name} already exists`);
    if (name.includes('invalid')) return cfError(400, 1097, 'This domain is not a registered domain');
    if (name.includes('forbidden')) return cfError(403, 10000, 'Authentication error');
    if (name.includes('weird')) return cfError(400, 1234, 'Something unexpected');
    return cf({ id: `cfz_${name.split('.')[0]}`, name, status: 'pending', name_servers: ['ada.ns.cloudflare.com', 'bob.ns.cloudflare.com'] });
  }
  if (segments[2] === undefined) {
    if (method === 'DELETE') return cf({ id: zoneId });
    if (zoneId === 'cfz_gone') return cfError(404, 1001, 'Invalid zone identifier');
    if (zoneId === 'cfz_forbidden') return cfError(403, 10000, 'Authentication error');
    const status = zoneId === 'cfz_active' || zoneId === 'cfz_live' ? 'active' : zoneId === 'cfz_moved' ? 'moved' : 'pending';
    return cf({ id: zoneId, status, name_servers: ['ada.ns.cloudflare.com', 'bob.ns.cloudflare.com'] });
  }
  // dns_records
  if (zoneId === 'cfz_forbidden') return cfError(403, 10000, 'Authentication error');
  const recordId = segments[3];
  if (method === 'GET' && recordId === undefined) {
    const page = Number(url.searchParams.get('page') ?? '1');
    return json({ success: true, errors: [], messages: [], result: page === 1 ? (ZONE_RECORDS[zoneId] ?? []) : [], result_info: { page, per_page: 100 } });
  }
  if (method === 'POST') {
    const name = String(body.name ?? '');
    if (name.includes('dup')) return cfError(400, 81057, 'Record already exists.');
    if (name.includes('reject')) return cfError(400, 9005, 'Content for A record is invalid.');
    return cf({ id: 'cfr_created', ...body });
  }
  if (method === 'PUT') {
    if (String(body.name ?? '').includes('reject')) return cfError(400, 9005, 'Content is invalid.');
    return cf({ id: recordId, ...body });
  }
  if (method === 'DELETE') {
    if (recordId === 'cfr_gone') return cfError(404, 81044, 'Record does not exist.');
    if (recordId === 'cfr_stuck') return cfError(400, 1004, 'DNS Validation Error');
    return cf({ id: recordId });
  }
  return cfError(404, 7003, 'Not found');
}

function cloudflareRegistrar(method: string, segments: string[]): Response {
  // accounts/{account}/registrar/{registrations|domains}/{name}
  const resource = segments[3];
  const name = decodeURIComponent(segments[4] ?? '');
  if (name.includes('denied')) return cfError(403, 10000, 'Authentication error');
  if (name.includes('refused')) return cfError(400, 1001, 'Registrar refused the change');
  if (resource === 'registrations' && method === 'GET') {
    return cf({ domain_name: name, status: 'active', expires_at: '2027-02-03T04:05:06Z', auto_renew: true, locked: false, privacy_mode: 'redaction' });
  }
  if (resource === 'registrations' && method === 'PATCH') return cf({ state: 'succeeded' });
  if (resource === 'domains' && method === 'PUT') return cf({ id: name });
  return cfError(404, 7003, 'Not found');
}

function cloudflare(method: string, url: URL, body: Record<string, unknown>): Response {
  const segments = url.pathname.replace('/client/v4/', '').split('/');
  if (segments[0] === 'zones') return cloudflareZones(method, segments, body, url);
  if (segments[0] === 'accounts' && segments[2] === 'registrar') return cloudflareRegistrar(method, segments);
  return cfError(404, 7003, 'Not found');
}

// ── DNS over HTTPS ──────────────────────────────────────────────────────────

const TYPE_CODES: Record<string, number> = { A: 1, NS: 2, CNAME: 5, MX: 15, TXT: 16, AAAA: 28, SRV: 33, CAA: 257 };

/** Public records by `name|type`. */
const PUBLIC_DNS: Record<string, Array<{ name: string; type: number; TTL: number; data: string }>> = {
  '_weldhost-verify.verified-site.com|TXT': [
    { name: '_weldhost-verify.verified-site.com.', type: 16, TTL: 300, data: '"weldhost-verify=0123456789abcdef0123456789abcdef"' },
    { name: '_weldhost-verify.verified-site.com.', type: 16, TTL: 300, data: '"other"' },
  ],
  '_weldhost-verify.taken-site.com|TXT': [
    { name: '_weldhost-verify.taken-site.com.', type: 16, TTL: 300, data: '"weldhost-verify=0123456789abcdef0123456789abcdef"' },
  ],
  '_weldhost-verify.invalid-site.com|TXT': [
    { name: '_weldhost-verify.invalid-site.com.', type: 16, TTL: 300, data: '"weldhost-verify=0123456789abcdef0123456789abcdef"' },
  ],
  '_weldhost-verify.forbidden-site.com|TXT': [
    { name: '_weldhost-verify.forbidden-site.com.', type: 16, TTL: 300, data: '"weldhost-verify=0123456789abcdef0123456789abcdef"' },
  ],
  '_weldhost-verify.weird-site.com|TXT': [
    { name: '_weldhost-verify.weird-site.com.', type: 16, TTL: 300, data: '"weldhost-verify=0123456789abcdef0123456789abcdef"' },
  ],
  '_weldhost-verify.wrong-site.com|TXT': [
    { name: '_weldhost-verify.wrong-site.com.', type: 16, TTL: 300, data: '"weldhost-verify=nope"' },
  ],
  'scan-site.com|A': [{ name: 'scan-site.com.', type: 1, TTL: 300, data: '198.51.100.1' }],
  'scan-site.com|MX': [{ name: 'scan-site.com.', type: 15, TTL: 3600, data: '10 mx1.scan-site.com.' }],
  'scan-site.com|TXT': [
    { name: 'scan-site.com.', type: 16, TTL: 300, data: '"v=spf1 " "include:_spf.example -all"' },
  ],
  'scan-site.com|NS': [{ name: 'scan-site.com.', type: 2, TTL: 86400, data: 'ns1.registrar.example.' }],
  'scan-site.com|CAA': [{ name: 'scan-site.com.', type: 257, TTL: 3600, data: '0 issue "letsencrypt.org"' }],
  'www.scan-site.com|CNAME': [
    { name: 'www.scan-site.com.', type: 5, TTL: 300, data: 'scan-site.com.' },
    { name: 'scan-site.com.', type: 1, TTL: 300, data: '198.51.100.1' },
  ],
  '_dmarc.scan-site.com|TXT': [{ name: '_dmarc.scan-site.com.', type: 16, TTL: 300, data: '"v=DMARC1; p=none"' }],
  '_weldhost-verify.scan-site.com|TXT': [{ name: '_weldhost-verify.scan-site.com.', type: 16, TTL: 300, data: '"weldhost-verify=x"' }],
};

function doh(url: URL): Response {
  const name = url.searchParams.get('name') ?? '';
  const type = url.searchParams.get('type') ?? '';
  if (name.includes('dnsdown')) return json({ Status: 2 }, 502);
  if (name.startsWith('mail.scan-site')) return new Response('not json', { status: 200 });
  const answer = PUBLIC_DNS[`${name}|${type}`];
  return json(answer ? { Status: 0, Answer: answer } : { Status: 3 });
}

// ── The stub ────────────────────────────────────────────────────────────────

/** The fetch stub; install it with `vi.stubGlobal('fetch', stub)`. */
export function createProviderFetchStub() {
  const realFetch = globalThis.fetch;
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const href = urlOf(input);
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const body = bodyOf(init);
    if (href.startsWith(RTR)) return realtimeRegister(method, href.slice(RTR.length).split('?')[0]!, new URL(href), body);
    if (href.startsWith(RTR_OTE)) return realtimeRegister(method, href.slice(RTR_OTE.length).split('?')[0]!, new URL(href), body);
    if (href === ADAC) return adac(body);
    if (href.startsWith(CF)) return cloudflare(method, new URL(href), body);
    if (href.startsWith(DOH)) return doh(new URL(href));
    return realFetch(input, init);
  });
}

/** The provider calls a stub saw, as `METHOD url`. */
export function providerCalls(stub: ReturnType<typeof createProviderFetchStub>): string[] {
  return stub.mock.calls
    .map(([input, init]) => `${(init?.method ?? 'GET').toUpperCase()} ${urlOf(input)}`)
    .filter((call) => !call.includes('127.0.0.1') && !call.includes('localhost'));
}
