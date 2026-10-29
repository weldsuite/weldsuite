import { request } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { outboundBridgeUrl, recordOutbound, sortOutbound, takeRustOutbound } from './outbound-bridge';

/** A request to the bridge that doesn't go through the stubbed `fetch`. */
function send(url: string, method: string, body?: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method, headers: body ? { 'content-type': 'application/json' } : {} }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  takeRustOutbound();
});

describe('outbound bridge', () => {
  it("replays a call into the test's fetch and records it", async () => {
    const stub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/invitations') && init?.method === 'POST') {
        return new Response(JSON.stringify({ id: 'inv_1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', stub);

    const bridge = await outboundBridgeUrl();
    const target = encodeURIComponent('https://api.clerk.com/v1/organizations/org_1/invitations');
    const answer = await send(`${bridge}/fetch?url=${target}`, 'POST', JSON.stringify({ email_address: 'a@b.test' }));

    expect(answer).toEqual({ status: 200, text: '{"id":"inv_1"}' });
    expect(takeRustOutbound()).toEqual([
      {
        method: 'POST',
        url: 'https://api.clerk.com/v1/organizations/org_1/invitations',
        body: { email_address: 'a@b.test' },
      },
    ]);
  });

  it('answers 502 with a marker when the stub throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('offline'))));
    const bridge = await outboundBridgeUrl();
    const answer = await send(`${bridge}/fetch?url=${encodeURIComponent('https://api.clerk.com/v1/users/u')}`, 'DELETE');
    expect(answer.status).toBe(502);
  });

  it("passes the call's own headers through, both ways, without the hop-by-hop ones", async () => {
    const stub = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      return new Response(JSON.stringify({ accept: headers.get('accept'), host: headers.get('host') }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-ratelimit-remaining': '9' },
      });
    });
    vi.stubGlobal('fetch', stub);

    const bridge = await outboundBridgeUrl();
    const target = encodeURIComponent('https://api.example.test/v1/contacts');
    const answer = await new Promise<{ text: string; remaining: unknown }>((resolve, reject) => {
      const req = request(`${bridge}/fetch?url=${target}`, { headers: { accept: 'application/json' } }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({ text: Buffer.concat(chunks).toString(), remaining: res.headers['x-ratelimit-remaining'] }),
        );
      });
      req.on('error', reject);
      req.end();
    });
    expect(JSON.parse(answer.text)).toEqual({ accept: 'application/json', host: null });
    expect(answer.remaining).toBe('9');
  });

  it('records the body of a call made with a Request', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    const { calls } = await recordOutbound(async () => {
      await fetch(new Request('https://api.example.test/v1/contacts', { method: 'POST', body: '{"name":"Ann"}' }));
    });
    expect(calls).toEqual([{ method: 'POST', url: 'https://api.example.test/v1/contacts', body: { name: 'Ann' } }]);
  });

  it("records the route's own calls and leaves loopback out", async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    const { calls } = await recordOutbound(async () => {
      await fetch('https://api.clerk.com/v1/organizations/org_1', { method: 'PATCH', body: '{"name":"A"}' });
      await fetch('http://127.0.0.1:1/__conformance/side-effects');
      await fetch('https://api.clerk.com/v1/organizations/org_1/memberships?limit=1');
    });
    expect(sortOutbound(calls)).toEqual([
      { method: 'GET', url: 'https://api.clerk.com/v1/organizations/org_1/memberships?limit=1', body: null },
      { method: 'PATCH', url: 'https://api.clerk.com/v1/organizations/org_1', body: { name: 'A' } },
    ]);
  });
});
