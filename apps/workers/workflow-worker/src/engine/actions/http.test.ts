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

  it.each([
    'http://localhost:8080/x',
    'http://127.0.0.1/x',
    'http://10.0.0.5/x',
    'http://192.168.1.1/x',
    'http://169.254.169.254/latest/meta-data',
    'http://internal-svc.internal/x',
    'http://metadata/computeMetadata/v1/',
    'http://localhost./x',
    'https://weldsuite.org/x',
    'https://app-api.weldsuite.org/api/internal/x',
    'https://app-api-test.weldsuite.org/x',
    'https://some-worker.acme.workers.dev/x',
    'http://[::1]/x',
    'http://[::]/x',
    'http://[fc00::1]/x',
    'http://[fd12:3456:789a::1]/x',
    'http://[fe80::1]/x',
    'http://[febf::1]/x',
    'http://[::ffff:10.0.0.5]/x',
    'http://[::ffff:127.0.0.1]/x',
    'http://[::ffff:192.168.1.1]/x',
    'http://2130706433/x',
  ])(
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

describe('http_request public targets', () => {
  it.each(['https://notweldsuite.org/x', 'https://weldsuite.org.example.com/x', 'https://example.com/x', 'http://[2606:4700:4700::1111]/x', 'http://172.32.0.1/x'])(
    'allows %s',
    async (url) => {
      stubFetch(() => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
      await expect(handleHttpRequest({ url }, makeActionContext())).resolves.toMatchObject({ status: 200 });
    },
  );
});

describe('response headers', () => {
  it('does not hand set-cookie to the workflow context', async () => {
    const headers = new Headers({ 'content-type': 'text/plain', 'x-request-id': 'abc' });
    headers.append('set-cookie', 'session=secret; HttpOnly');
    stubFetch(() => new Response('ok', { status: 200, headers }));
    const res = (await handleHttpRequest({ url: 'https://api.test/x' }, makeActionContext())) as {
      headers: Record<string, string>;
    };
    expect(res.headers['x-request-id']).toBe('abc');
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('does not put set-cookie into a 4xx failure payload either', async () => {
    const headers = new Headers({ 'content-type': 'text/plain' });
    headers.append('set-cookie', 'session=secret');
    stubFetch(() => new Response('no', { status: 403, statusText: 'Forbidden', headers }));
    const err = (await handleHttpRequest({ url: 'https://api.test/x' }, makeActionContext()).catch((e) => e)) as NonRetryableStepError;
    expect(err).toBeInstanceOf(NonRetryableStepError);
    const details = err.details as { headers: Record<string, string> };
    expect(details.headers['set-cookie']).toBeUndefined();
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

  it('rejects WeldSuite hostnames', async () => {
    await expect(
      handleWebhook({ url: 'https://app-api.weldsuite.org/api/internal/x', body: {} }, makeActionContext()),
    ).rejects.toThrow(NonRetryableStepError);
  });

  it('times out instead of hanging on a slow endpoint', async () => {
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
      handleWebhook({ url: 'https://hooks.test/slow', body: {}, timeout: 10 }, makeActionContext()),
    ).rejects.toThrow(/timed out/i);
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
      type: 'github',
      status: 'connected',
      credentials: { accessToken: 'tok123' },
    });
  });

  it('injects a bearer token from the resolved integration', async () => {
    const { calls } = stubFetch(() => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
    await handleHttpRequest(
      { url: 'https://api.github.com/user', integrationType: 'github' },
      makeActionContext({ db }),
    );
    const auth = new Headers(calls[0].init?.headers).get('authorization');
    expect(auth).toBe('Bearer tok123');
  });

  it('fails the step instead of sending the token to a host that is not the provider API', async () => {
    const { mock } = stubFetch(() => new Response('{}', { status: 200 }));
    const err = (await handleHttpRequest(
      { url: 'https://evil.example.com/steal', integrationType: 'github' },
      makeActionContext({ db }),
    ).catch((e) => e)) as Error;
    expect(err).toBeInstanceOf(NonRetryableStepError);
    expect(err.message).toMatch(/github integration's token can only be sent to its own API host/);
    expect(mock).not.toHaveBeenCalled();
  });

  it('does not match a look-alike of the provider host', async () => {
    const { mock } = stubFetch(() => new Response('{}', { status: 200 }));
    await expect(
      handleHttpRequest(
        { url: 'https://api.github.com.evil.example.com/x', integrationType: 'github' },
        makeActionContext({ db }),
      ),
    ).rejects.toThrow(NonRetryableStepError);
    await expect(
      handleHttpRequest(
        { url: 'https://api.github.com@evil.example.com/x', integrationType: 'github' },
        makeActionContext({ db }),
      ),
    ).rejects.toThrow(NonRetryableStepError);
    expect(mock).not.toHaveBeenCalled();
  });

  it('applies the same host check to webhooks', async () => {
    const { mock } = stubFetch(() => new Response('{}', { status: 200 }));
    await expect(
      handleWebhook({ url: 'https://evil.example.com/in', integrationType: 'github', body: {} }, makeActionContext({ db })),
    ).rejects.toThrow(NonRetryableStepError);
    expect(mock).not.toHaveBeenCalled();
  });

  it('lets an explicit Authorization header win over the integration', async () => {
    const { calls } = stubFetch(() => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
    await handleHttpRequest(
      {
        url: 'https://api.github.com/user',
        integrationType: 'github',
        headers: { Authorization: 'Bearer override' },
      },
      makeActionContext({ db }),
    );
    const auth = new Headers(calls[0].init?.headers).get('authorization');
    expect(auth).toBe('Bearer override');
  });
});
