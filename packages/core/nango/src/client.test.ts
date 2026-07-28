import { describe, it, expect, vi } from 'vitest';
import { NangoClient, createNangoClient } from './client';
import { NangoApiError } from './errors';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

function makeClient(fetchImpl: typeof fetch, overrides = {}) {
  return new NangoClient({
    secretKey: 'sk_test',
    host: 'https://nango.test',
    connectUrl: 'https://connect.nango.test',
    maxRetries: 2,
    fetchImpl,
    ...overrides,
  });
}

describe('NangoClient transport', () => {
  it('sends the secret key as a bearer token and never in the query string', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ connections: [] }));
    await makeClient(fetchImpl as unknown as typeof fetch).listConnections();

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://nango.test/connections');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk_test');
    expect(String(url)).not.toContain('sk_test');
  });

  it('throws a classified NangoApiError on failure', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('nope', { status: 401 }));

    await expect(makeClient(fetchImpl as unknown as typeof fetch).listConnections()).rejects.toMatchObject({
      name: 'NangoApiError',
      status: 401,
      kind: 'auth',
    });
    // Auth failures are not retried — reconnecting is the only fix.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries a rate-limited request and surfaces Retry-After', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('slow down', { status: 429, headers: { 'Retry-After': '0' } }))
      .mockResolvedValueOnce(jsonResponse({ connections: [{ connection_id: 'c1', provider_config_key: 'hubspot', id: 1 }] }));

    const connections = await makeClient(fetchImpl as unknown as typeof fetch).listConnections();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(connections).toHaveLength(1);
  });

  it('does not retry a sync trigger — a duplicate doubles provider load', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('boom', { status: 500 }));

    await expect(
      makeClient(fetchImpl as unknown as typeof fetch).triggerSync({
        provider_config_key: 'hubspot',
        connection_id: 'c1',
      }),
    ).rejects.toBeInstanceOf(NangoApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('NangoClient connect sessions', () => {
  it('unwraps the session token and builds the hosted Connect URL', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ data: { token: 'sess_123', expires_at: '2026-01-01T00:00:00Z' } }));
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    const session = await client.createConnectSession({
      end_user: { id: 'user_1' },
      organization: { id: 'org_1' },
      allowed_integrations: ['hubspot'],
    });

    expect(session.token).toBe('sess_123');
    expect(client.connectUiUrl(session.token)).toBe('https://connect.nango.test?session_token=sess_123');

    const [, init] = fetchImpl.mock.calls[0]!;
    expect(JSON.parse(init.body as string)).toMatchObject({
      end_user: { id: 'user_1' },
      organization: { id: 'org_1' },
    });
  });
});

describe('NangoClient records', () => {
  it('passes connection identity as headers and the watermark as a query param', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ records: [], next_cursor: null }));

    await makeClient(fetchImpl as unknown as typeof fetch).listRecords({
      providerConfigKey: 'hubspot',
      connectionId: 'conn-1',
      model: 'HubspotContact',
      modifiedAfter: '2026-01-01T00:00:00Z',
    });

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toContain('model=HubspotContact');
    expect(String(url)).toContain('modified_after=2026-01-01T00%3A00%3A00Z');
    const headers = init.headers as Record<string, string>;
    expect(headers['Provider-Config-Key']).toBe('hubspot');
    expect(headers['Connection-Id']).toBe('conn-1');
  });

  it('iterates pages until the cursor runs out', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ records: [{ id: '1', _nango_metadata: {} }], next_cursor: 'cur-2' }))
      .mockResolvedValueOnce(jsonResponse({ records: [{ id: '2', _nango_metadata: {} }], next_cursor: null }));

    const pages: string[][] = [];
    for await (const page of makeClient(fetchImpl as unknown as typeof fetch).iterateRecords({
      providerConfigKey: 'hubspot',
      connectionId: 'conn-1',
      model: 'HubspotContact',
    })) {
      pages.push(page.records.map((r) => r.id));
    }

    expect(pages).toEqual([['1'], ['2']]);
  });

  it('stops at maxPages so a Worker invocation cannot run away', async () => {
    // A fresh Response per call — a Response body can only be read once.
    const fetchImpl = vi
      .fn()
      .mockImplementation(async () =>
        jsonResponse({ records: [{ id: '1', _nango_metadata: {} }], next_cursor: 'always-more' }),
      );

    let pages = 0;
    for await (const _page of makeClient(fetchImpl as unknown as typeof fetch).iterateRecords({
      providerConfigKey: 'hubspot',
      connectionId: 'conn-1',
      model: 'HubspotContact',
      maxPages: 3,
    })) {
      pages++;
    }

    expect(pages).toBe(3);
  });
});

describe('createNangoClient', () => {
  it('returns null when Nango is unconfigured so callers can 503 cleanly', () => {
    expect(createNangoClient({})).toBeNull();
  });

  it('builds a client from the env bag', () => {
    expect(createNangoClient({ NANGO_SECRET_KEY: 'sk' })).toBeInstanceOf(NangoClient);
  });
});
