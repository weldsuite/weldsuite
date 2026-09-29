import { describe, expect, it } from 'vitest';
import worker, { AppApiInternal } from '../../index';

const env = { ENVIRONMENT: 'test' };

const post = (path: string, headers: Record<string, string> = {}) =>
  new Request(`https://internal${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: '{}',
  });

describe('AppApiInternal entrypoint', () => {
  const entrypoint = (e: object) => new AppApiInternal({} as ExecutionContext, e as never);

  it('accepts send-email without the secret (the body is validated next)', async () => {
    // No INTERNAL_API_SECRET configured and no bearer: the public path answers 503.
    const res = await entrypoint(env).fetch(post('/api/internal/send-email'));
    expect(res.status).toBe(400);
  });

  it('accepts send-transactional-email without the secret', async () => {
    const res = await entrypoint({ ...env, INTERNAL_API_SECRET: 's' }).fetch(
      post('/api/internal/send-transactional-email'),
    );
    expect(res.status).toBe(400);
  });

  it('does not expose any other app-api route', async () => {
    const res = await entrypoint(env).fetch(new Request('https://internal/api/me'));
    expect(res.status).toBe(404);
  });
});

describe('public /api/internal', () => {
  const secretEnv = { ...env, INTERNAL_API_SECRET: 'internal-secret' };

  it('stays guarded by the INTERNAL_API_SECRET bearer', async () => {
    const path = '/api/internal/send-email';
    expect((await worker.fetch(post(path), env as never)).status).toBe(503);
    expect((await worker.fetch(post(path), secretEnv as never)).status).toBe(401);
    expect((await worker.fetch(post(path, { Authorization: 'Bearer wrong' }), secretEnv as never)).status).toBe(401);
    // Authenticated: the body is validated (400) before any send.
    expect(
      (await worker.fetch(post(path, { Authorization: 'Bearer internal-secret' }), secretEnv as never)).status,
    ).toBe(400);
  });
});
