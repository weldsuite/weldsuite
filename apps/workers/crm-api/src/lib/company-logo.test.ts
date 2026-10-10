import { describe, expect, it } from 'vitest';
import { normalizeLogoDomain } from '@weldsuite/app-api-client/schemas/company-logos';
import {
  LOGO_ERROR_TTL_MS,
  LOGO_HIT_TTL_MS,
  LOGO_MAX_BYTES,
  LOGO_MISS_TTL_MS,
  isAllowedFetchTarget,
  logoObjectKey,
  logoPublicBase,
  parseIconLinks,
  resolveCompanyLogos,
  sniffImageType,
  type FetchLike,
} from './company-logo';
import { FakeR2 } from '../test/fake-r2';

const PUBLIC_URL = 'https://storage.example-cdn.org';
const WS = 'ws_1';

/** A PNG: the magic number plus filler, big enough to pass the minimum size. */
function png(size = 200): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return bytes;
}

type Reply = { status?: number; headers?: Record<string, string>; body?: Uint8Array | string | null } | Error;

/** A fake internet: url -> reply. Unknown urls are 404. Every request is recorded. */
function internet(replies: Record<string, Reply>) {
  const calls: string[] = [];
  const fetcher: FetchLike = async (input) => {
    calls.push(input);
    const reply = replies[input];
    if (reply instanceof Error) throw reply;
    if (!reply) return new Response('not found', { status: 404 });
    return new Response(reply.body ?? null, { status: reply.status ?? 200, headers: reply.headers });
  };
  return { fetcher, calls };
}

function setup(replies: Record<string, Reply>, start = 1_700_000_000_000) {
  const storage = new FakeR2();
  const net = internet(replies);
  const clock = { now: start };
  const resolve = (inputs: string[], workspaceId = WS) =>
    resolveCompanyLogos(inputs, {
      storage: storage.asBucket(),
      r2PublicUrl: PUBLIC_URL,
      workspaceId,
      fetcher: net.fetcher,
      now: () => clock.now,
    });
  return { storage, net, clock, resolve };
}

describe('normalizeLogoDomain', () => {
  it.each([
    ['acme.com', 'acme.com'],
    ['ACME.com', 'acme.com'],
    ['https://www.acme.com/about?x=1#top', 'acme.com'],
    ['http://acme.co.uk:8080/', 'acme.co.uk'],
    ['www.acme.com.', 'acme.com'],
    ['info@acme.com', 'acme.com'],
    ['https://user:pw@acme.com/', 'acme.com'],
    ['  acme.nl  ', 'acme.nl'],
    ['bücher.de', 'xn--bcher-kva.de'],
    ['shop.acme.com', 'shop.acme.com'],
  ])('accepts %s as %s', (input, expected) => {
    expect(normalizeLogoDomain(input)).toBe(expected);
  });

  it.each([
    '',
    '   ',
    'localhost',
    'http://localhost:3000',
    '127.0.0.1',
    'https://192.168.1.10/admin',
    '10.0.0.1',
    '2130706433',
    '[::1]',
    'http://[::ffff:127.0.0.1]/',
    'intranet',
    'printer.local',
    'host.internal',
    'service.test',
    'acme',
    '-acme.com',
    'acme..com',
    'ac me.com',
    'acme.c',
    'acme.123',
    'gmail.com',
    'jane@outlook.com',
    'https://www.hotmail.nl',
    `${'a'.repeat(64)}.com`,
  ])('rejects %j', (input) => {
    expect(normalizeLogoDomain(input)).toBeNull();
  });

  it('rejects non-strings', () => {
    expect(normalizeLogoDomain(undefined)).toBeNull();
    expect(normalizeLogoDomain(null)).toBeNull();
  });
});

describe('isAllowedFetchTarget', () => {
  it('allows a public https URL on the default port', () => {
    expect(isAllowedFetchTarget(new URL('https://cdn.acme.com/icon.png'))).toBe(true);
    expect(isAllowedFetchTarget(new URL('https://acme.com:443/icon.png'))).toBe(true);
  });

  it.each([
    'http://acme.com/icon.png',
    'https://acme.com:8443/icon.png',
    'https://user:pw@acme.com/icon.png',
    'https://127.0.0.1/icon.png',
    'https://[::1]/icon.png',
    'https://localhost/icon.png',
    'https://metadata.internal/icon.png',
    'ftp://acme.com/icon.png',
  ])('refuses %s', (url) => {
    expect(isAllowedFetchTarget(new URL(url))).toBe(false);
  });
});

describe('sniffImageType', () => {
  it('recognises raster images by their magic bytes', () => {
    expect(sniffImageType(png())).toBe('image/png');
    expect(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe('image/jpeg');
    expect(sniffImageType(new TextEncoder().encode('GIF89a\u0001\u0000'))).toBe('image/gif');
    expect(sniffImageType(new Uint8Array([0, 0, 1, 0, 1, 0, 16, 16]))).toBe('image/x-icon');
    const webp = new Uint8Array(16);
    webp.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
    expect(sniffImageType(webp)).toBe('image/webp');
  });

  it('refuses SVG, HTML and empty bodies', () => {
    expect(sniffImageType(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
    expect(sniffImageType(new TextEncoder().encode('<!doctype html><html></html>'))).toBeNull();
    expect(sniffImageType(new Uint8Array(0))).toBeNull();
  });
});

describe('parseIconLinks', () => {
  const base = new URL('https://www.acme.com/en/');

  it('prefers apple-touch-icon, then the largest icon, and resolves relative hrefs', () => {
    const html = `
      <head>
        <link rel="icon" href="/small.png" sizes="16x16">
        <link rel="shortcut icon" href="favicon.ico">
        <link rel="apple-touch-icon" sizes="180x180" href="/apple.png">
        <link rel="icon" type="image/png" sizes="32x32" href="//cdn.acme.com/32.png">
      </head>`;
    expect(parseIconLinks(html, base).map((u) => u.href)).toEqual([
      'https://www.acme.com/apple.png',
      'https://cdn.acme.com/32.png',
    ]);
  });

  it('skips SVG icons, data: URLs and unrelated links', () => {
    const html = `
      <link rel="icon" type="image/svg+xml" href="/icon.svg">
      <link rel="icon" href="/logo.svg?v=2">
      <link rel="icon" href="data:image/png;base64,AAAA">
      <link rel="mask-icon" href="/mask.svg">
      <link rel="stylesheet" href="/app.css">`;
    expect(parseIconLinks(html, base)).toEqual([]);
  });

  it('reads single-quoted and unquoted attributes and decodes &amp;', () => {
    const html = `<link href='/a.png?x=1&amp;y=2' rel=icon>`;
    expect(parseIconLinks(html, base).map((u) => u.href)).toEqual(['https://www.acme.com/a.png?x=1&y=2']);
  });
});

describe('logoPublicBase', () => {
  it('uses the bucket hostname when deployed', () => {
    expect(logoPublicBase('https://crm-api.weldsuite.org/api/company-logos/resolve', PUBLIC_URL)).toBe(PUBLIC_URL);
    expect(logoPublicBase('https://app-api-test.weldsuite.org/api/company-logos/resolve', PUBLIC_URL)).toBe(PUBLIC_URL);
  });

  it('serves local objects through app-api under wrangler dev, where the bucket hostname is the remote one', () => {
    expect(logoPublicBase('http://localhost:8801/api/company-logos/resolve', PUBLIC_URL)).toBe(
      'http://localhost:8789/api/storage/public',
    );
    expect(logoPublicBase('http://127.0.0.1:8789/api/company-logos/resolve', PUBLIC_URL)).toBe(
      'http://127.0.0.1:8789/api/storage/public',
    );
  });
});

describe('resolveCompanyLogos', () => {
  const KEY = logoObjectKey(WS, 'acme.com');
  const PUBLIC = `${PUBLIC_URL}/${KEY}`;

  it('fetches the logo from the company site once, stores it, and serves it from the cache after', async () => {
    const { storage, net, resolve } = setup({
      'https://acme.com/': {
        headers: { 'content-type': 'text/html' },
        body: '<html><head><link rel="icon" href="/logo-32.png" sizes="32x32"></head></html>',
      },
      'https://acme.com/logo-32.png': { headers: { 'content-type': 'image/png' }, body: png() },
    });

    expect(await resolve(['acme.com'])).toEqual({ 'acme.com': PUBLIC });
    expect(net.calls).toEqual(['https://acme.com/', 'https://acme.com/logo-32.png']);
    // Only the company's own host was contacted.
    expect(net.calls.every((u) => new URL(u).hostname === 'acme.com')).toBe(true);

    const stored = storage.objects.get(KEY);
    expect(stored?.httpMetadata?.contentType).toBe('image/png');
    expect(stored?.customMetadata?.status).toBe('hit');
    expect(stored?.body.byteLength).toBe(200);

    expect(await resolve(['acme.com'])).toEqual({ 'acme.com': PUBLIC });
    expect(net.calls).toHaveLength(2);
  });

  it('falls back to /favicon.ico when the page declares no icon', async () => {
    const { net, resolve } = setup({
      'https://acme.com/': { headers: { 'content-type': 'text/html' }, body: '<html></html>' },
      'https://acme.com/favicon.ico': { body: new Uint8Array([0, 0, 1, 0, 1, 0, ...new Uint8Array(150)]) },
    });
    expect(await resolve(['acme.com'])).toEqual({ 'acme.com': PUBLIC });
    expect(net.calls).toEqual(['https://acme.com/', 'https://acme.com/favicon.ico']);
  });

  it('follows a redirect to the www host and resolves /favicon.ico there', async () => {
    const { net, resolve } = setup({
      'https://acme.com/': { status: 301, headers: { location: 'https://www.acme.com/' } },
      'https://www.acme.com/': { headers: { 'content-type': 'text/html' }, body: '<html></html>' },
      'https://www.acme.com/favicon.ico': { body: png() },
    });
    expect(await resolve(['acme.com'])).toEqual({ 'acme.com': PUBLIC });
    expect(net.calls).toContain('https://www.acme.com/favicon.ico');
  });

  it('tries the www host when the bare domain serves nothing', async () => {
    const { net, resolve } = setup({
      'https://acme.com/': new TypeError('connection refused'),
      'https://acme.com/favicon.ico': new TypeError('connection refused'),
      'https://www.acme.com/': { headers: { 'content-type': 'text/html' }, body: '<html></html>' },
      'https://www.acme.com/favicon.ico': { body: png() },
    });
    expect(await resolve(['acme.com'])).toEqual({ 'acme.com': PUBLIC });
    expect(net.calls).toContain('https://www.acme.com/');
  });

  it('caches a miss, so a company without a logo is not fetched again', async () => {
    const { storage, net, clock, resolve } = setup({
      'https://acme.com/': { headers: { 'content-type': 'text/html' }, body: '<html></html>' },
    });

    expect(await resolve(['acme.com'])).toEqual({ 'acme.com': null });
    const firstRound = net.calls.length;
    expect(firstRound).toBeGreaterThan(0);
    expect(storage.objects.get(KEY)?.customMetadata).toEqual({
      status: 'miss',
      expiresAt: String(clock.now + LOGO_MISS_TTL_MS),
    });

    // Within the TTL: answered from the marker, no outbound request.
    clock.now += LOGO_MISS_TTL_MS - 1000;
    expect(await resolve(['acme.com'])).toEqual({ 'acme.com': null });
    expect(net.calls).toHaveLength(firstRound);

    // After it: asked again.
    clock.now += 2000;
    await resolve(['acme.com']);
    expect(net.calls.length).toBeGreaterThan(firstRound);
  });

  it('looks a hit up again after a month and replaces the logo', async () => {
    const { storage, net, clock, resolve } = setup({
      'https://acme.com/': { headers: { 'content-type': 'text/html' }, body: '<html></html>' },
      'https://acme.com/favicon.ico': { body: png(200) },
    });
    await resolve(['acme.com']);
    const calls = net.calls.length;

    clock.now += LOGO_HIT_TTL_MS - 1000;
    await resolve(['acme.com']);
    expect(net.calls).toHaveLength(calls);

    clock.now += 2000;
    await resolve(['acme.com']);
    expect(net.calls.length).toBeGreaterThan(calls);
    expect(storage.objects.get(KEY)?.customMetadata?.status).toBe('hit');
  });

  it('retries a site that errored sooner than one that simply has no logo', async () => {
    const { storage, clock, resolve } = setup({
      'https://acme.com/': new TypeError('network lost'),
      'https://acme.com/favicon.ico': new TypeError('network lost'),
      'https://www.acme.com/': new TypeError('network lost'),
      'https://www.acme.com/favicon.ico': new TypeError('network lost'),
    });
    expect(await resolve(['acme.com'])).toEqual({ 'acme.com': null });
    expect(storage.objects.get(KEY)?.customMetadata?.expiresAt).toBe(String(clock.now + LOGO_ERROR_TTL_MS));
    expect(LOGO_ERROR_TTL_MS).toBeLessThan(LOGO_MISS_TTL_MS);
  });

  it('keeps an existing logo when the refresh cannot reach the site', async () => {
    const replies: Record<string, Reply> = {
      'https://acme.com/': { headers: { 'content-type': 'text/html' }, body: '<html></html>' },
      'https://acme.com/favicon.ico': { body: png() },
    };
    const { storage, clock, resolve } = setup(replies);
    await resolve(['acme.com']);

    replies['https://acme.com/'] = new TypeError('network lost');
    replies['https://acme.com/favicon.ico'] = new TypeError('network lost');
    replies['https://www.acme.com/'] = new TypeError('network lost');
    replies['https://www.acme.com/favicon.ico'] = new TypeError('network lost');
    clock.now += LOGO_HIT_TTL_MS + 1000;

    expect(await resolve(['acme.com'])).toEqual({ 'acme.com': PUBLIC });
    expect(storage.objects.get(KEY)?.customMetadata?.status).toBe('hit');
  });

  it('never fetches for something that is not a public company domain', async () => {
    const { storage, net, resolve } = setup({});
    const inputs = ['localhost', '127.0.0.1', 'http://192.168.0.1/admin', 'intranet', 'gmail.com', 'jane@yahoo.com', 'not a domain'];
    const result = await resolve(inputs);
    expect(Object.values(result).every((v) => v === null)).toBe(true);
    expect(Object.keys(result).sort()).toEqual([...inputs].sort());
    expect(net.calls).toEqual([]);
    expect(storage.putCalls).toBe(0);
  });

  it('does not follow a redirect to a non-public or non-https host', async () => {
    const { storage, net, resolve } = setup({
      'https://acme.com/': { status: 302, headers: { location: 'https://169.254.169.254/latest/meta-data/' } },
      'https://acme.com/favicon.ico': { status: 302, headers: { location: 'http://acme.com/favicon.ico' } },
      'https://www.acme.com/': { status: 302, headers: { location: 'https://localhost:8080/' } },
      'https://www.acme.com/favicon.ico': { status: 307, headers: { location: 'https://intranet/favicon.ico' } },
    });
    expect(await resolve(['acme.com'])).toEqual({ 'acme.com': null });
    expect(net.calls.some((u) => /169\.254|localhost|intranet|^http:/.test(u))).toBe(false);
    expect(storage.objects.get(KEY)?.customMetadata?.status).toBe('miss');
  });

  it('gives up after three redirects', async () => {
    const { net, resolve } = setup({
      'https://acme.com/': { status: 302, headers: { location: 'https://a.acme.com/' } },
      'https://a.acme.com/': { status: 302, headers: { location: 'https://b.acme.com/' } },
      'https://b.acme.com/': { status: 302, headers: { location: 'https://c.acme.com/' } },
      'https://c.acme.com/': { status: 302, headers: { location: 'https://d.acme.com/' } },
      'https://d.acme.com/': { headers: { 'content-type': 'text/html' }, body: '<link rel="icon" href="/x.png">' },
      'https://d.acme.com/x.png': { body: png() },
    });
    expect((await resolve(['acme.com']))['acme.com']).toBeNull();
    expect(net.calls).not.toContain('https://d.acme.com/');
  });

  it('refuses SVG, HTML served as a favicon, and tiny images', async () => {
    const { storage, resolve } = setup({
      'https://acme.com/': {
        headers: { 'content-type': 'text/html' },
        body: '<link rel="icon" href="/a.png"><link rel="apple-touch-icon" href="/b.png">',
      },
      // Declared as an image, but it is an SVG with a script in it.
      'https://acme.com/a.png': {
        headers: { 'content-type': 'image/png' },
        body: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'.padEnd(200, ' '),
      },
      // A "soft 404": 200 with an HTML page.
      'https://acme.com/favicon.ico': { headers: { 'content-type': 'image/x-icon' }, body: '<!doctype html><html>'.padEnd(300, ' ') },
      // A 1x1 pixel.
      'https://acme.com/b.png': { headers: { 'content-type': 'image/png' }, body: png(60) },
    });
    expect(await resolve(['acme.com'])).toEqual({ 'acme.com': null });
    expect(storage.objects.get(KEY)?.customMetadata?.status).toBe('miss');
    expect(storage.objects.get(KEY)?.body.byteLength).toBe(0);
  });

  it('stores what the bytes are, not what the server claims', async () => {
    const { storage, resolve } = setup({
      'https://acme.com/': { headers: { 'content-type': 'text/html' }, body: '<html></html>' },
      'https://acme.com/favicon.ico': { headers: { 'content-type': 'text/html' }, body: png() },
    });
    await resolve(['acme.com']);
    expect(storage.objects.get(KEY)?.httpMetadata?.contentType).toBe('image/png');
  });

  it('refuses an image over the size cap', async () => {
    const { storage, resolve } = setup({
      'https://acme.com/': { headers: { 'content-type': 'text/html' }, body: '<html></html>' },
      'https://acme.com/favicon.ico': { body: png(LOGO_MAX_BYTES + 1) },
    });
    expect(await resolve(['acme.com'])).toEqual({ 'acme.com': null });
    expect(storage.objects.get(KEY)?.customMetadata?.status).toBe('miss');
  });

  it('shares one lookup between spellings of the same domain', async () => {
    const { net, resolve } = setup({
      'https://acme.com/': { headers: { 'content-type': 'text/html' }, body: '<html></html>' },
      'https://acme.com/favicon.ico': { body: png() },
    });
    const result = await resolve(['acme.com', 'https://www.ACME.com/contact', 'sales@acme.com']);
    expect(result).toEqual({
      'acme.com': PUBLIC,
      'https://www.ACME.com/contact': PUBLIC,
      'sales@acme.com': PUBLIC,
    });
    expect(net.calls.filter((u) => u === 'https://acme.com/')).toHaveLength(1);
  });

  it('keeps each workspace in its own namespace', async () => {
    const { storage, net, resolve } = setup({
      'https://acme.com/': { headers: { 'content-type': 'text/html' }, body: '<html></html>' },
      'https://acme.com/favicon.ico': { body: png() },
    });
    const one = await resolve(['acme.com'], 'ws_1');
    const two = await resolve(['acme.com'], 'ws_2');
    expect(one['acme.com']).toBe(`${PUBLIC_URL}/workspaces/ws_1/company-logos/acme.com`);
    expect(two['acme.com']).toBe(`${PUBLIC_URL}/workspaces/ws_2/company-logos/acme.com`);
    expect([...storage.objects.keys()].sort()).toEqual([
      'workspaces/ws_1/company-logos/acme.com',
      'workspaces/ws_2/company-logos/acme.com',
    ]);
    // ws_2 did not get to read ws_1's cache: it fetched for itself.
    expect(net.calls.filter((u) => u === 'https://acme.com/')).toHaveLength(2);
  });

  it('answers null for a domain whose lookup throws, without failing the batch', async () => {
    const { storage, resolve } = setup({
      'https://acme.com/': { headers: { 'content-type': 'text/html' }, body: '<html></html>' },
      'https://acme.com/favicon.ico': { body: png() },
    });
    const head = storage.head.bind(storage);
    storage.head = async (key: string) => {
      if (key.endsWith('/broken.com')) throw new Error('R2 unavailable');
      return head(key);
    };
    const result = await resolve(['broken.com', 'acme.com']);
    expect(result['broken.com']).toBeNull();
    expect(result['acme.com']).toBe(PUBLIC);
  });
});
