import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, createClientApi, isApiError, isNetworkError } from './client.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const refused = () =>
  json({ error: { code: 'REVERIFICATION_REQUIRED', message: 'Confirm', details: { level: 'second_factor' } } }, 403);

interface Sent {
  url: string;
  method: string;
  authorization: string | null;
  contentType: string | null;
  body: unknown;
}

/** A fetch that refuses each request's first send with a step-up, and records every send. */
function stepUpServer() {
  const sent: Sent[] = [];
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    sent.push({
      url,
      method: init.method ?? 'GET',
      authorization: headers.get('Authorization'),
      contentType: headers.get('Content-Type'),
      body: init.body,
    });
    if (sent.length % 2 === 1) return refused();
    return init.method === 'DELETE' ? new Response(null, { status: 204 }) : json({ data: { ok: true } });
  });
  vi.stubGlobal('fetch', fetch);
  return sent;
}

/** A client whose token changes on every read, as after a new sign-in. */
function client(onStepUp?: () => Promise<boolean>) {
  let reads = 0;
  return createClientApi({
    getToken: () => Promise.resolve(`at-${++reads}`),
    baseUrl: 'https://api.example.test',
    onStepUp,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createClientApi with onStepUp', () => {
  it('sends every kind of request once more, with a fresh token, after the person confirms', async () => {
    const sent = stepUpServer();
    const onStepUp = vi.fn().mockResolvedValue(true);
    const api = client(onStepUp);

    await expect(api.get('/bank-accounts/ba_1')).resolves.toEqual({ data: { ok: true } });
    await expect(api.post('/team-members/invite', { email: 'a@b.test' })).resolves.toEqual({ data: { ok: true } });
    await expect(api.put('/roles/role_1', { name: 'Ops' })).resolves.toEqual({ data: { ok: true } });
    await expect(api.patch('/team-members/mem_1', { role: 'ADMIN' })).resolves.toEqual({ data: { ok: true } });
    await expect(api.delete('/workspace-api-keys/wak_1')).resolves.toEqual({});
    await expect(api.postForm('/files', new FormData())).resolves.toEqual({ data: { ok: true } });
    const raw = await api.getRaw('/bank-accounts/ba_1/statement');
    expect(raw.status).toBe(200);

    expect(onStepUp).toHaveBeenCalledTimes(7);
    expect(sent.map((s) => s.method)).toEqual(['GET', 'GET', 'POST', 'POST', 'PUT', 'PUT', 'PATCH', 'PATCH', 'DELETE', 'DELETE', 'POST', 'POST', 'GET', 'GET']);
    // Each retry reads the token again.
    expect(sent[0].authorization).toBe('Bearer at-1');
    expect(sent[1].authorization).toBe('Bearer at-2');
    expect(sent[2].url).toBe('https://api.example.test/api/team-members/invite');
    expect(sent[3].body).toBe(JSON.stringify({ email: 'a@b.test' }));
    // A form keeps its multipart boundary: no JSON content type.
    expect(sent[11].contentType).toBeNull();
  });

  it('throws the refusal, with its code, when the person does not confirm', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => refused()));
    const api = client(() => Promise.resolve(false));
    const error = await api.post('/team-members/invite', {}).catch((err: unknown) => err);
    expect(isApiError(error)).toBe(true);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(403);
    expect((error as ApiError).code).toBe('REVERIFICATION_REQUIRED');
    expect((error as ApiError).message).toBe('Confirm');
    await expect(api.getRaw('/x')).rejects.toMatchObject({ status: 403, code: 'REVERIFICATION_REQUIRED' });
  });

  it('without onStepUp, sends once and throws the refusal', async () => {
    const sent = stepUpServer();
    await expect(client().delete('/workspace-api-keys/wak_1')).rejects.toMatchObject({ status: 403 });
    expect(sent).toHaveLength(1);
  });
});

describe('ApiError.code', () => {
  it('is the API error code, or null when the body has none', () => {
    expect(new ApiError('x', 404, { error: { code: 'NOT_FOUND', message: 'Gone' } }).code).toBe('NOT_FOUND');
    expect(new ApiError('x', 500, { error: 'Request failed' }).code).toBeNull();
    expect(new ApiError('x', 500, { error: { code: 42 } }).code).toBeNull();
    expect(new ApiError('x', 500).code).toBeNull();
  });

  it('is not a network error', () => {
    expect(isNetworkError(new ApiError('x', 403))).toBe(false);
  });
});
