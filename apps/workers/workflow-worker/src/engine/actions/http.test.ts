import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { handleHttpRequest, handleWebhook } from './http';
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
  it('returns status + parsed JSON data', async () => {
    stubFetch(() => new Response(JSON.stringify({ hi: 1 }), { status: 200, statusText: 'OK', headers: { 'content-type': 'application/json' } }));
    const res = (await handleHttpRequest({ url: 'https://api.test/x', method: 'GET' }, makeActionContext())) as {
      status: number;
      data: unknown;
    };
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ hi: 1 });
  });

  it('falls back to raw text when the body is not JSON', async () => {
    stubFetch(() => new Response('plain', { status: 200 }));
    const res = (await handleHttpRequest({ url: 'https://api.test/x' }, makeActionContext())) as { data: unknown };
    expect(res.data).toBe('plain');
  });

  it('throws when url is missing', async () => {
    await expect(handleHttpRequest({}, makeActionContext())).rejects.toThrow(/url/i);
  });

  it('JSON-encodes the body and sends a content-type header', async () => {
    const { calls } = stubFetch(() => new Response('{}', { status: 200 }));
    await handleHttpRequest({ url: 'https://api.test/x', method: 'POST', body: { a: 1 } }, makeActionContext());
    expect(calls[0].init?.method).toBe('POST');
    expect(calls[0].init?.body).toBe(JSON.stringify({ a: 1 }));
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
    const { calls } = stubFetch(() => new Response('{}', { status: 200 }));
    await handleHttpRequest(
      { url: 'https://api.test/secure', integrationType: 'http_auth_fixture' },
      makeActionContext({ db }),
    );
    const auth = new Headers(calls[0].init?.headers).get('authorization');
    expect(auth).toBe('Bearer tok123');
  });

  it('lets an explicit Authorization header win over the integration', async () => {
    const { calls } = stubFetch(() => new Response('{}', { status: 200 }));
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
