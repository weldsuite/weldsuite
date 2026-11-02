import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSignPortalClient, forwardedClientIp, signPortalClientFromEnv } from './portal-client';

const meta = { ip: '203.0.113.7', userAgent: 'Mozilla/5.0 (signer)' };

interface Seen {
  url: string;
  method: string;
  headers: Headers;
  body: string | null;
}

/** A fetch that records each call and answers with `answer`. */
function stub(answer: () => Response) {
  const seen: Seen[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : null,
    });
    return answer();
  }) as typeof fetch;
  return { seen, fetchImpl };
}

describe('createSignPortalClient', () => {
  it('opens a session: the token as JSON, the signer and the key as headers', async () => {
    const { seen, fetchImpl } = stub(() =>
      Response.json({ data: { state: 'ready', session: 'sess', expiresAt: '2026-10-29T12:00:00.000Z' } }),
    );
    const client = createSignPortalClient({ url: 'http://weldsuite/', secret: 'portal-secret', fetch: fetchImpl });
    const res = await client.openSession(meta, { token: 'tok_1' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { state: 'ready', session: 'sess', expiresAt: '2026-10-29T12:00:00.000Z' } });
    expect(seen).toHaveLength(1);
    const [call] = seen;
    expect(call!.url).toBe('http://weldsuite/public/sign-portal/session');
    expect(call!.method).toBe('POST');
    expect(call!.body).toBe('{"token":"tok_1"}');
    expect(call!.headers.get('content-type')).toBe('application/json');
    expect(call!.headers.get('x-sign-portal-key')).toBe('portal-secret');
    expect(call!.headers.get('x-signer-ip')).toBe('203.0.113.7');
    expect(call!.headers.get('user-agent')).toBe('Mozilla/5.0 (signer)');
    expect(call!.headers.has('authorization')).toBe(false);
  });

  it('sends the signer session as a bearer token and maps every operation to its path', async () => {
    const { seen, fetchImpl } = stub(() => Response.json({ data: {} }));
    const client = createSignPortalClient({ url: 'https://api.example.eu', secret: 's', fetch: fetchImpl });
    await client.verify(meta, { token: 't', code: '123456' });
    await client.resendCode(meta, { token: 't' });
    await client.envelope(meta, 'sess');
    await client.document(meta, 'sess', 'doc/1 2');
    await client.consent(meta, 'sess', { disclosureVersion: 'v1' });
    await client.complete(meta, 'sess', { values: {}, signature: 'data:image/png;base64,AAAA' });
    await client.decline(meta, 'sess', { reason: 'no' });
    await client.download(meta, 'sess');

    expect(seen.map((s) => `${s.method} ${s.url.replace('https://api.example.eu/public/sign-portal', '')}`)).toEqual([
      'POST /verify',
      'POST /resend-code',
      'GET /envelope',
      'GET /documents/doc%2F1%202',
      'POST /consent',
      'POST /complete',
      'POST /decline',
      'GET /download',
    ]);
    expect(seen.slice(2).every((s) => s.headers.get('authorization') === 'Bearer sess')).toBe(true);
    expect(seen.filter((s) => s.method === 'GET').every((s) => s.body === null)).toBe(true);
    expect(seen[5]!.body).toBe('{"values":{},"signature":"data:image/png;base64,AAAA"}');
  });

  it('passes the answer on as it is: status, error body, the headers a signer needs', async () => {
    const { fetchImpl } = stub(
      () =>
        new Response(JSON.stringify({ error: { code: 'INVALID_CODE', message: 'That code is not correct', details: { attemptsLeft: 4 } } }), {
          status: 400,
          headers: { 'content-type': 'application/json', 'set-cookie': 'backend=1', server: 'weldsuite' },
        }),
    );
    const client = createSignPortalClient({ url: 'http://weldsuite', secret: 's', fetch: fetchImpl });
    const res = await client.verify(meta, { token: 't', code: '000000' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: 'INVALID_CODE', message: 'That code is not correct', details: { attemptsLeft: 4 } } });
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(res.headers.has('set-cookie')).toBe(false);
    expect(res.headers.has('server')).toBe(false);
  });

  it('leaves out the IP and browser it does not know, and still sends no session without one', async () => {
    const { seen, fetchImpl } = stub(() => Response.json({ error: { code: 'UNAUTHORIZED', message: 'x' } }, { status: 401 }));
    const client = createSignPortalClient({ url: 'http://weldsuite', secret: 's', fetch: fetchImpl });
    const res = await client.envelope({ ip: null, userAgent: null }, undefined);
    expect(res.status).toBe(401);
    expect(seen[0]!.headers.has('x-signer-ip')).toBe(false);
    expect(seen[0]!.headers.has('authorization')).toBe(false);
  });

  it('answers 503 when the backend cannot be reached', async () => {
    const client = createSignPortalClient({
      url: 'http://weldsuite',
      secret: 's',
      fetch: (async () => {
        throw new TypeError('fetch failed');
      }) as typeof fetch,
    });
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    try {
      const res = await client.openSession(meta, { token: 't' });
      expect(res.status).toBe(503);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('SERVICE_UNAVAILABLE');
    } finally {
      console.error = original;
    }
    expect(errors).toHaveLength(1);
  });
});

describe('against a stub backend over HTTP', () => {
  const requests: { method?: string; url?: string; headers: IncomingMessage['headers']; body: string }[] = [];
  const pdf = Buffer.from('%PDF-1.7\n\x00\x01\x02\xff binary', 'latin1');
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      if (req.url === '/public/sign-portal/documents/doc_1') {
        res.writeHead(200, { 'content-type': 'application/pdf', 'cache-control': 'private, no-store' });
        res.end(pdf);
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { consented: true } }));
    });
  });
  let url = '';

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('streams a PDF through byte for byte and posts JSON', async () => {
    const client = createSignPortalClient({ url, secret: 'portal-secret' });
    const doc = await client.document(meta, 'sess', 'doc_1');
    expect(doc.status).toBe(200);
    expect(doc.headers.get('content-type')).toBe('application/pdf');
    expect(doc.headers.get('cache-control')).toBe('private, no-store');
    expect(Buffer.from(await doc.arrayBuffer()).equals(pdf)).toBe(true);

    const consent = await client.consent(meta, 'sess', { disclosureVersion: 'v1' });
    expect(await consent.json()).toEqual({ data: { consented: true } });
    const posted = requests.at(-1)!;
    expect(posted.method).toBe('POST');
    expect(posted.body).toBe('{"disclosureVersion":"v1"}');
    expect(posted.headers['x-sign-portal-key']).toBe('portal-secret');
    expect(posted.headers['x-signer-ip']).toBe('203.0.113.7');
    expect(posted.headers.authorization).toBe('Bearer sess');
  });
});

describe('signPortalClientFromEnv', () => {
  it('keeps the domain code unless the backend is rust', () => {
    expect(signPortalClientFromEnv({})).toBeNull();
    expect(signPortalClientFromEnv({ SIGN_PORTAL_BACKEND: 'domain' })).toBeNull();
    expect(signPortalClientFromEnv({ SIGN_PORTAL_BACKEND: ' ' })).toBeNull();
  });

  it('needs the URL and the secret with rust, and refuses anything else', () => {
    expect(() => signPortalClientFromEnv({ SIGN_PORTAL_BACKEND: 'rust', SIGN_PORTAL_SECRET: 's' })).toThrow(/SIGN_PORTAL_BACKEND_URL/);
    expect(() =>
      signPortalClientFromEnv({ SIGN_PORTAL_BACKEND: 'rust', SIGN_PORTAL_BACKEND_URL: 'weldsuite', SIGN_PORTAL_SECRET: 's' }),
    ).toThrow(/SIGN_PORTAL_BACKEND_URL/);
    expect(() => signPortalClientFromEnv({ SIGN_PORTAL_BACKEND: 'rust', SIGN_PORTAL_BACKEND_URL: 'http://weldsuite' })).toThrow(
      /SIGN_PORTAL_SECRET/,
    );
    expect(() => signPortalClientFromEnv({ SIGN_PORTAL_BACKEND: 'workers' })).toThrow(/rust or domain/);
  });

  it('calls the configured backend', async () => {
    const { seen, fetchImpl } = stub(() => Response.json({ data: { sent: true } }));
    const client = signPortalClientFromEnv(
      { SIGN_PORTAL_BACKEND: 'rust', SIGN_PORTAL_BACKEND_URL: 'http://weldsuite.weldsuite.svc', SIGN_PORTAL_SECRET: 'k' },
      fetchImpl,
    );
    await client!.resendCode(meta, { token: 't' });
    expect(seen[0]!.url).toBe('http://weldsuite.weldsuite.svc/public/sign-portal/resend-code');
    expect(seen[0]!.headers.get('x-sign-portal-key')).toBe('k');
  });
});

describe('forwardedClientIp', () => {
  it('takes the address the trusted proxy saw, counted from the right', () => {
    expect(forwardedClientIp('203.0.113.7')).toBe('203.0.113.7');
    // A client-sent value is never taken: the ingress appended the real one.
    expect(forwardedClientIp('1.1.1.1, 203.0.113.7')).toBe('203.0.113.7');
    // Behind a CDN the ingress trusts: the CDN appended the client.
    expect(forwardedClientIp('203.0.113.7, 198.51.100.2', 2)).toBe('203.0.113.7');
    expect(forwardedClientIp('2001:db8::1')).toBe('2001:db8::1');
  });

  it('is null without enough hops or for anything but an address', () => {
    expect(forwardedClientIp(null)).toBeNull();
    expect(forwardedClientIp('')).toBeNull();
    expect(forwardedClientIp('203.0.113.7', 2)).toBeNull();
    expect(forwardedClientIp('203.0.113.7', 0)).toBeNull();
    expect(forwardedClientIp('<script>')).toBeNull();
  });
});
