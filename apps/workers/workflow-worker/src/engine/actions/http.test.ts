import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { handleHttpRequest, handleWebhook } from './http';
import { NonRetryableStepError } from '../errors';
import { makeActionContext } from '../../test/ctx';
import { createPgliteDb } from '../../test/pglite';
import { schema, type Database } from '../../db';
import { generateId } from '../../lib/id';

function stubFetch(impl: (url: string, init?: RequestInit) => Response) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const mock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return impl(url, init);
  });
  vi.stubGlobal('fetch', mock);
  return { mock, calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('http_request', () => {
  it('returns status + ok + headers + parsed JSON body', async () => {
    stubFetch(() => new Response(JSON.stringify({ hi: 1 }), { status: 200, statusText: 'OK', headers: { 'content-type': 'application/json' } }));
    const res = (await handleHttpRequest({ url: 'https://api.test/x', method: 'GET' }, makeActionContext())) as {
      status: number;
      ok: boolean;
      headers: Record<string, string>;
      body: unknown;
    };
    expect(res.status).toBe(200);
    expect(res.ok).toBe(true);
    expect(res.body).toEqual({ hi: 1 });
    expect(res.headers['content-type']).toContain('application/json');
  });

  it('returns the raw text when the content-type is not JSON', async () => {
    stubFetch(() => new Response('plain', { status: 200, headers: { 'content-type': 'text/plain' } }));
    const res = (await handleHttpRequest({ url: 'https://api.test/x' }, makeActionContext())) as { body: unknown };
    expect(res.body).toBe('plain');
  });

  it('throws when url is missing', async () => {
    await expect(handleHttpRequest({}, makeActionContext())).rejects.toThrow(/url/i);
  });

  it('rejects a non-http(s) scheme', async () => {
    await expect(
      handleHttpRequest({ url: 'file:///etc/passwd' }, makeActionContext()),
    ).rejects.toThrow(NonRetryableStepError);
  });

  it.each(['http://localhost:8080/x', 'http://127.0.0.1/x', 'http://10.0.0.5/x', 'http://192.168.1.1/x', 'http://169.254.169.254/latest/meta-data', 'http://internal-svc.internal/x'])(
    'rejects an internal-network target %s',
    async (url) => {
      await expect(handleHttpRequest({ url }, makeActionContext())).rejects.toThrow(NonRetryableStepError);
    },
  );

  it('JSON-encodes the body and sends a content-type header', async () => {
    const { calls } = stubFetch(() => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
    await handleHttpRequest({ url: 'https://api.test/x', method: 'POST', body: { a: 1 } }, makeActionContext());
    expect(calls[0].init?.method).toBe('POST');
    expect(calls[0].init?.body).toBe(JSON.stringify({ a: 1 }));
  });

  it('throws NonRetryableStepError on a 4xx (will not retry)', async () => {
    stubFetch(() => new Response(JSON.stringify({ error: 'nope' }), { status: 404, statusText: 'Not Found', headers: { 'content-type': 'application/json' } }));
    await expect(handleHttpRequest({ url: 'https://api.test/x' }, makeActionContext())).rejects.toThrow(NonRetryableStepError);
  });

  it('throws a plain (retryable) Error on a 5xx', async () => {
    stubFetch(() => new Response('boom', { status: 503, statusText: 'Service Unavailable' }));
    const err: unknown = await handleHttpRequest({ url: 'https://api.test/x' }, makeActionContext()).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(NonRetryableStepError);
    expect((err as Error).message).toMatch(/503/);
  });

  it('times out and throws a retryable error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
      ),
    );
    await expect(
      handleHttpRequest({ url: 'https://api.test/slow', timeout: 10 }, makeActionContext()),
    ).rejects.toThrow(/timed out/i);
  });

  it('truncates a response body larger than the cap instead of failing', async () => {
    const big = 'x'.repeat(2_000_000);
    stubFetch(() => new Response(big, { status: 200, headers: { 'content-type': 'text/plain' } }));
    const res = (await handleHttpRequest({ url: 'https://api.test/big' }, makeActionContext())) as { body: string };
    expect(res.body.length).toBeLessThanOrEqual(1_000_000);
  });
});

describe('webhook', () => {
  it('posts and returns success + parsed response', async () => {
    const { calls } = stubFetch(() => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const res = (await handleWebhook(
      { url: 'https://hooks.test/in', body: { event: 'x' } },
      makeActionContext(),
    )) as { success: boolean; status: number };
    expect(res.success).toBe(true);
    expect(res.status).toBe(200);
    expect(calls[0].init?.method).toBe('POST');
  });

  it('throws when url is missing', async () => {
    await expect(handleWebhook({}, makeActionContext())).rejects.toThrow(/url/i);
  });

  it('throws on a non-2xx response', async () => {
    stubFetch(() => new Response('nope', { status: 500 }));
    await expect(
      handleWebhook({ url: 'https://hooks.test/in', body: {} }, makeActionContext()),
    ).rejects.toThrow(/500/);
  });

  it('rejects an internal-network target', async () => {
    await expect(
      handleWebhook({ url: 'http://127.0.0.1/in', body: {} }, makeActionContext()),
    ).rejects.toThrow();
  });
});

describe('http_request with integration auth (pglite)', () => {
  let db: Database;

  beforeAll(async () => {
    const handle = await createPgliteDb();
    db = handle.db;
    await db.insert(schema.workflowIntegrations).values({
      id: generateId('win'),
      name: 'Authed HTTP',
      type: 'http_auth_fixture',
      status: 'connected',
      credentials: { accessToken: 'tok123' },
    });
  });

  it('injects a bearer token from the resolved integration', async () => {
    const { calls } = stubFetch(() => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
    await handleHttpRequest(
      { url: 'https://api.test/secure', integrationType: 'http_auth_fixture' },
      makeActionContext({ db }),
    );
    const auth = new Headers(calls[0].init?.headers).get('authorization');
    expect(auth).toBe('Bearer tok123');
  });

  it('lets an explicit Authorization header win over the integration', async () => {
    const { calls } = stubFetch(() => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
    await handleHttpRequest(
      {
        url: 'https://api.test/secure',
        integrationType: 'http_auth_fixture',
        headers: { Authorization: 'Bearer override' },
      },
      makeActionContext({ db }),
    );
    const auth = new Headers(calls[0].init?.headers).get('authorization');
    expect(auth).toBe('Bearer override');
  });
});
