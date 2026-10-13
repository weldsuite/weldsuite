import { describe, it, expect, vi } from 'vitest';
import { consultVies, interpretViesBody, ViesUnavailableError } from './vies';

const OUTAGE = {
  actionSucceed: false,
  errorWrappers: [{ error: 'MS_MAX_CONCURRENT_REQ' }],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('interpretViesBody', () => {
  it('treats the real member-state outage payload as unavailable, not invalid', () => {
    const verdict = interpretViesBody({ ...OUTAGE, valid: false });
    expect(verdict).toEqual({ kind: 'unavailable', reason: 'MS_MAX_CONCURRENT_REQ', retryable: true });
  });

  it.each(['MS_UNAVAILABLE', 'TIMEOUT', 'SERVICE_UNAVAILABLE', 'GLOBAL_MAX_CONCURRENT_REQ'])(
    '%s is an outage',
    (code) => {
      const verdict = interpretViesBody({ actionSucceed: false, errorWrappers: [{ error: code }], valid: false });
      expect(verdict.kind).toBe('unavailable');
    },
  );

  it('only throttling errors are retryable', () => {
    expect(interpretViesBody({ errorWrappers: [{ error: 'MS_UNAVAILABLE' }] })).toMatchObject({ retryable: false });
    expect(interpretViesBody({ errorWrappers: [{ error: 'GLOBAL_MAX_CONCURRENT_REQ' }] })).toMatchObject({ retryable: true });
  });

  it('treats actionSucceed=false without wrappers, an unknown userError and a missing flag as unavailable', () => {
    expect(interpretViesBody({ actionSucceed: false, valid: false }).kind).toBe('unavailable');
    expect(interpretViesBody({ userError: 'MS_UNAVAILABLE', valid: false }).kind).toBe('unavailable');
    expect(interpretViesBody({}).kind).toBe('unavailable');
    expect(interpretViesBody(null).kind).toBe('unavailable');
  });

  it('reads a normal valid answer', () => {
    expect(interpretViesBody({ valid: true, actionSucceed: true, userError: 'VALID', name: 'ACME BV' })).toEqual({
      kind: 'verdict',
      valid: true,
    });
  });

  it('reads a normal invalid answer as a verdict', () => {
    expect(interpretViesBody({ valid: false, actionSucceed: true, userError: 'INVALID' })).toEqual({
      kind: 'verdict',
      valid: false,
    });
  });

  it('treats a malformed-input error as a definitive invalid number', () => {
    expect(interpretViesBody({ actionSucceed: false, errorWrappers: [{ error: 'INVALID_INPUT' }] })).toEqual({
      kind: 'verdict',
      valid: false,
    });
  });
});

describe('consultVies', () => {
  const target = { countryCode: 'DE', number: '123456789' };

  it('returns a valid answer without retrying', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ valid: true, actionSucceed: true }));
    const result = await consultVies(target, { fetchFn, sleep: async () => {} });
    expect(result.valid).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('retries once on MS_MAX_CONCURRENT_REQ and uses the second answer', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ ...OUTAGE, valid: false }))
      .mockResolvedValueOnce(jsonResponse({ valid: true, actionSucceed: true }));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const result = await consultVies(target, { fetchFn, sleep });
    expect(result.valid).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('throws ViesUnavailableError (never "invalid") when the retry fails too', async () => {
    const fetchFn = vi.fn().mockImplementation(async () => jsonResponse({ ...OUTAGE, valid: false }));
    await expect(consultVies(target, { fetchFn, sleep: async () => {} })).rejects.toBeInstanceOf(ViesUnavailableError);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('does not retry a non-throttling outage', async () => {
    const fetchFn = vi
      .fn()
      .mockImplementation(async () => jsonResponse({ actionSucceed: false, errorWrappers: [{ error: 'MS_UNAVAILABLE' }], valid: false }));
    await expect(consultVies(target, { fetchFn, sleep: async () => {} })).rejects.toBeInstanceOf(ViesUnavailableError);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('treats an HTTP error as unavailable', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({}, 503));
    await expect(consultVies(target, { fetchFn, sleep: async () => {} })).rejects.toBeInstanceOf(ViesUnavailableError);
  });

  it('returns an invalid verdict as a result', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ valid: false, actionSucceed: true, userError: 'INVALID' }));
    const result = await consultVies(target, { fetchFn, sleep: async () => {} });
    expect(result.valid).toBe(false);
  });
});
