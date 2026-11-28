import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setStepUpHandler } from '../step-up';
import { setWeldbooksTokenGetter } from '../weldbooks-client';
import { paymentErrorCode, paymentErrorStatus, paymentsApi } from './weldbooks-payments';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** The first call is refused for a second factor, the second goes through. */
function refuseOnce(answer: () => Response) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : undefined });
      return calls.length === 1 ? json({ error: { code: 'REVERIFICATION_REQUIRED', message: 'Confirm it is you' } }, 403) : answer();
    }),
  );
  return calls;
}

describe('paymentsApi step-up', () => {
  beforeEach(() => setWeldbooksTokenGetter(() => Promise.resolve('token')));
  afterEach(() => {
    setStepUpHandler(null);
    setWeldbooksTokenGetter(null);
    vi.unstubAllGlobals();
  });

  it('asks for a second factor before Mollie Connect, then sends the call once more', async () => {
    const calls = refuseOnce(() => json({ data: { authorizeUrl: 'https://my.mollie.com/oauth2/authorize' } }));
    const onStepUp = vi.fn().mockResolvedValue(true);
    setStepUpHandler(onStepUp);

    await expect(paymentsApi.authorizeMollie('https://app.test/settings')).resolves.toEqual({
      data: { authorizeUrl: 'https://my.mollie.com/oauth2/authorize' },
    });

    expect(onStepUp).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ method: 'POST', body: { returnUrl: 'https://app.test/settings' } });
    expect(calls[1]?.url).toContain('/api/accounting-payment-connections/mollie/authorize');
  });

  it('asks for a second factor before an API key is stored', async () => {
    const calls = refuseOnce(() => json({ data: { id: 'pc_1' } }, 201));
    const onStepUp = vi.fn().mockResolvedValue(true);
    setStepUpHandler(onStepUp);

    await paymentsApi.connectWithApiKey({ apiKey: 'live_x', profileId: 'pfl_1' });

    expect(onStepUp).toHaveBeenCalledTimes(1);
    expect(calls[1]).toMatchObject({ method: 'POST', body: { apiKey: 'live_x', profileId: 'pfl_1' } });
    expect(calls[1]?.url).toContain('/mollie/api-key');
  });

  it('asks for a second factor before disconnecting', async () => {
    const calls = refuseOnce(() => new Response(null, { status: 204 }));
    const onStepUp = vi.fn().mockResolvedValue(true);
    setStepUpHandler(onStepUp);

    await expect(paymentsApi.disconnect('pc_1')).resolves.toBeUndefined();

    expect(onStepUp).toHaveBeenCalledTimes(1);
    expect(calls[1]).toMatchObject({ method: 'DELETE' });
    expect(calls[1]?.url).toMatch(/\/accounting-payment-connections\/pc_1$/);
  });

  it('throws the refusal when the person does not confirm', async () => {
    refuseOnce(() => json({ data: {} }));
    setStepUpHandler(vi.fn().mockResolvedValue(false));

    const error = await paymentsApi.disconnect('pc_1').catch((caught: unknown) => caught);

    expect(paymentErrorCode(error)).toBe('REVERIFICATION_REQUIRED');
    expect(paymentErrorStatus(error)).toBe(403);
  });

  it('reads no step-up for reading the connection', async () => {
    const onStepUp = vi.fn().mockResolvedValue(true);
    setStepUpHandler(onStepUp);
    vi.stubGlobal('fetch', vi.fn(async () => json({ data: null })));

    await expect(paymentsApi.getConnection()).resolves.toEqual({ data: null });
    expect(onStepUp).not.toHaveBeenCalled();
  });
});

describe('payment errors', () => {
  it('reads a code and a status from a refused call, and nothing from anything else', () => {
    expect(paymentErrorCode(Object.assign(new Error('x'), { code: 'MOLLIE_CONNECT_NOT_CONFIGURED', status: 409 }))).toBe(
      'MOLLIE_CONNECT_NOT_CONFIGURED',
    );
    expect(paymentErrorStatus(Object.assign(new Error('x'), { status: 409 }))).toBe(409);
    expect(paymentErrorCode(null)).toBeNull();
    expect(paymentErrorStatus('boom')).toBeNull();
  });
});
