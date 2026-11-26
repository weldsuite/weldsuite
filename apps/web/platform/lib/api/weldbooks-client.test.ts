import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatErrorMessage, setWeldbooksTokenGetter, weldbooksApi } from './weldbooks-client';
import { setStepUpHandler } from './step-up';

describe('formatErrorMessage', () => {
  it('reads the API error envelope', () => {
    expect(formatErrorMessage({ error: { code: 'BAD_REQUEST', message: 'Account code already exists' } }, 400)).toBe(
      'Account code already exists',
    );
    expect(formatErrorMessage({ error: 'Not found' }, 404)).toBe('Not found');
  });

  it('says which field a refused body got wrong', () => {
    const body = {
      success: false,
      error: {
        name: 'ZodError',
        issues: [
          { code: 'invalid_type', expected: 'string', message: 'Expected string, received number', path: ['openingBalance'] },
          { code: 'too_small', message: 'Array must contain at least 2 element(s)', path: ['lines'] },
        ],
      },
    };
    expect(formatErrorMessage(body, 400)).toBe(
      'openingBalance: Expected string, received number. lines: Array must contain at least 2 element(s)',
    );
  });

  it('falls back to the status', () => {
    expect(formatErrorMessage({ error: { issues: [] } }, 400)).toBe('Request failed with status 400');
    expect(formatErrorMessage(null, 500)).toBe('Request failed with status 500');
  });
});

describe('weldbooksApi step-up (ADR SEC-022)', () => {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  afterEach(() => {
    setStepUpHandler(null);
    setWeldbooksTokenGetter(null);
    vi.unstubAllGlobals();
  });

  it('adds the bank account once the person confirms, with the new token', async () => {
    const tokens = ['at-1', 'at-2'];
    const seen: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        seen.push(new Headers(init.headers).get('Authorization') ?? '');
        return seen.length === 1
          ? json({ error: { code: 'MFA_REQUIRED', message: 'Set up two-step verification' } }, 403)
          : json({ data: { id: 'ba_1' } }, 201);
      }),
    );
    setWeldbooksTokenGetter(() => Promise.resolve(tokens[seen.length] ?? null));
    const onStepUp = vi.fn().mockResolvedValue(true);
    setStepUpHandler(onStepUp);
    await expect(weldbooksApi.post('/accounting/bank-accounts', { name: 'Main' })).resolves.toEqual({ data: { id: 'ba_1' } });
    expect(onStepUp).toHaveBeenCalledWith({ code: 'MFA_REQUIRED', level: 'second_factor', afterMinutes: null });
    expect(seen).toEqual(['Bearer at-1', 'Bearer at-2']);
  });

  it('throws the refusal, with its code, when nobody confirms', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: { code: 'REVERIFICATION_REQUIRED', message: 'Confirm' } }, 403)));
    setWeldbooksTokenGetter(() => Promise.resolve('at-1'));
    await expect(weldbooksApi.post('/accounting/bank-feeds/link-session', {})).rejects.toMatchObject({
      status: 403,
      code: 'REVERIFICATION_REQUIRED',
    });
  });
});
