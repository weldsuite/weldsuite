import { afterEach, describe, expect, it, vi } from 'vitest';
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

  it('requires a Stripe checkout reference on fulfill-number, even when authenticated', async () => {
    const secretEnv = { ...env, INTERNAL_API_SECRET: 'internal-secret' };
    const res = await worker.fetch(
      new Request('http://local/api/internal/telephony/fulfill-number', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer internal-secret' },
        body: JSON.stringify({
          clerkOrgId: 'org_victim',
          phoneNumber: '+31201234567',
          countryCode: 'NL',
          numberType: 'local',
        }),
      }),
      secretEnv as never,
    );
    expect(res.status).toBe(400);
  });

  it('refuses fulfilment (503) when Stripe is not configured, before buying anything', async () => {
    const secretEnv = { ...env, INTERNAL_API_SECRET: 'internal-secret' };
    const res = await worker.fetch(
      new Request('http://local/api/internal/telephony/fulfill-number', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer internal-secret' },
        body: JSON.stringify({
          checkoutSessionId: 'cs_test_abcdefgh',
          clerkOrgId: 'org_victim',
          phoneNumber: '+31201234567',
          countryCode: 'NL',
          numberType: 'local',
        }),
      }),
      secretEnv as never,
    );
    expect(res.status).toBe(503);
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

describe('call-api Telnyx webhook receiver', () => {
  const post = (headers: Record<string, string> = {}) =>
    new Request('http://local/public/webhooks/telnyx', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ data: { event_type: 'call.hangup', id: '1', occurred_at: '', payload: {}, record_type: 'event' }, meta: {} }),
    });

  afterEach(() => vi.restoreAllMocks());

  it('fails closed (401) when TELNYX_PUBLIC_KEY is not configured', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await worker.fetch(post(), env as never);
    expect(res.status).toBe(401);
    expect(errorSpy).toHaveBeenCalledWith('[Telnyx Webhook] TELNYX_PUBLIC_KEY not configured');
  });

  it('rejects unsigned and badly signed requests (401) when the key is configured', async () => {
    const keyedEnv = { ...env, TELNYX_PUBLIC_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' };
    expect((await worker.fetch(post(), keyedEnv as never)).status).toBe(401);
    const stamp = String(Math.floor(Date.now() / 1000));
    const forged = post({ 'telnyx-signature-ed25519': 'AAAA', 'telnyx-timestamp': stamp });
    expect((await worker.fetch(forged, keyedEnv as never)).status).toBe(401);
  });
});
