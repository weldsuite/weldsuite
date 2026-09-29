import { describe, expect, it } from 'vitest';
import worker, { ConnectInternal } from './index';

const env = { ENVIRONMENT: 'test' };

describe('connect-api', () => {
  it('answers unknown paths with the JSON error envelope', async () => {
    const res = await worker.fetch(new Request('http://local/nope'), env as never);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: 'NOT_FOUND', message: '/nope not found' } });
  });

  it('requires a bearer token on /api/*', async () => {
    const res = await worker.fetch(new Request('http://local/api/anything'), env as never);
    expect(res.status).toBe(401);
  });
});

describe('ConnectInternal entrypoint', () => {
  const secretEnv = { ...env, INTERNAL_API_SECRET: 'internal-secret' };
  const entrypoint = (e: object) => new ConnectInternal({} as ExecutionContext, e as never);
  const post = (path: string, headers: Record<string, string> = {}) =>
    new Request(`https://internal${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: '{}',
    });

  const create = '/api/internal/workflow-actions/create-customer';
  const sync = '/api/integrations/connections/intc_1/sync';

  it('accepts create-customer without the secret (the body is validated next)', async () => {
    // No INTERNAL_API_SECRET configured and no bearer: the public path answers 503.
    const res = await entrypoint(env).fetch(post(create));
    expect(res.status).toBe(400);
  });

  it('accepts integration internal calls without the secret (tenant header still required)', async () => {
    const res = await entrypoint(secretEnv).fetch(post(sync));
    expect(res.status).toBe(400);
  });

  it('does not expose the Clerk-authed routes', async () => {
    const res = await entrypoint(secretEnv).fetch(new Request('https://internal/api/workflows'));
    expect(res.status).toBe(404);
  });

  it('keeps the public paths secret-guarded', async () => {
    expect((await worker.fetch(post(create), secretEnv as never)).status).toBe(401);
    expect((await worker.fetch(post(create, { Authorization: 'Bearer wrong' }), secretEnv as never)).status).toBe(401);
    expect((await worker.fetch(post(create), env as never)).status).toBe(503);

    const wrongSecret = { 'X-Internal-Secret': 'wrong', 'X-Workspace-Id': 'org_1' };
    expect((await worker.fetch(post(sync, wrongSecret), secretEnv as never)).status).toBe(401);
  });
});
