import { describe, expect, it } from 'vitest';
import worker, { CallInternal } from './index';

const env = { ENVIRONMENT: 'test' };

describe('call-api', () => {
  it('answers unknown paths with the JSON error envelope', async () => {
    const res = await worker.fetch(new Request('http://local/nope'), env as never);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: 'NOT_FOUND', message: '/nope not found' } });
  });

  it('requires a bearer token on /api/*', async () => {
    const res = await worker.fetch(new Request('http://local/api/anything'), env as never);
    expect(res.status).toBe(401);
  });

  it('guards /api/internal/telephony with the INTERNAL_API_SECRET bearer, not Clerk', async () => {
    const url = 'http://local/api/internal/telephony/fulfill-number';
    const post = (headers: Record<string, string>) =>
      new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: '{}' });
    const secretEnv = { ...env, INTERNAL_API_SECRET: 'internal-secret' };

    expect((await worker.fetch(post({}), env as never)).status).toBe(503);
    expect((await worker.fetch(post({}), secretEnv as never)).status).toBe(401);
    expect((await worker.fetch(post({ Authorization: 'Bearer wrong' }), secretEnv as never)).status).toBe(401);
    // Authenticated: the body is validated (400) before any fulfilment work.
    expect(
      (await worker.fetch(post({ Authorization: 'Bearer internal-secret' }), secretEnv as never)).status,
    ).toBe(400);
  });

  it('serves /api/internal/telephony over the CallInternal entrypoint without the secret', async () => {
    const entrypoint = new CallInternal({} as ExecutionContext, env as never);
    const res = await entrypoint.fetch(
      new Request('https://internal/api/internal/telephony/fulfill-number', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }),
    );
    // Trusted by topology: no 503/401; the body is validated (400) before any fulfilment.
    expect(res.status).toBe(400);
  });

  it('exposes nothing but the internal telephony router on the entrypoint', async () => {
    const entrypoint = new CallInternal({} as ExecutionContext, env as never);
    expect((await entrypoint.fetch(new Request('https://internal/api/calls'))).status).toBe(404);
  });
});
