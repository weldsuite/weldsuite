/**
 * Step-up in the API clients (ADR SEC-022): a sensitive action the API
 * refuses until the person confirms their identity goes out once more, with
 * the new sign-in's token, after they do.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, createClientApi } from '@weldsuite/api-client';
import { sendWithStepUp, stepUpChallengeOf } from '@weldsuite/api-client/step-up';
import { confirmStepUp, setStepUpHandler } from './step-up';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const reverify = (level: string) =>
  json({ error: { code: 'REVERIFICATION_REQUIRED', message: 'Confirm', details: { level, afterMinutes: 10 } } }, 403);

afterEach(() => {
  setStepUpHandler(null);
  vi.unstubAllGlobals();
});

describe('stepUpChallengeOf', () => {
  it('reads what the API asks to confirm', () => {
    expect(stepUpChallengeOf(403, { error: { code: 'MFA_REQUIRED' } })).toEqual({
      code: 'MFA_REQUIRED',
      level: 'second_factor',
      afterMinutes: null,
    });
    expect(
      stepUpChallengeOf(403, { error: { code: 'REVERIFICATION_REQUIRED', details: { level: 'first_factor', afterMinutes: 10 } } }),
    ).toEqual({ code: 'REVERIFICATION_REQUIRED', level: 'first_factor', afterMinutes: 10 });
    // Clerk's books-api refusal names no level: the second factor.
    expect(stepUpChallengeOf(403, { error: { code: 'REVERIFICATION_REQUIRED' } })?.level).toBe('second_factor');
  });

  it('ignores every other answer', () => {
    expect(stepUpChallengeOf(403, { error: { code: 'FORBIDDEN' } })).toBeNull();
    expect(stepUpChallengeOf(401, { error: { code: 'REVERIFICATION_REQUIRED' } })).toBeNull();
    expect(stepUpChallengeOf(403, 'nope')).toBeNull();
  });
});

describe('sendWithStepUp', () => {
  it('sends once more after the person confirms', async () => {
    const send = vi.fn().mockResolvedValueOnce(reverify('second_factor')).mockResolvedValueOnce(json({ data: { id: 'wak_1' } }));
    const onStepUp = vi.fn().mockResolvedValue(true);
    const response = await sendWithStepUp(send, onStepUp);
    expect(response.status).toBe(200);
    expect(send).toHaveBeenCalledTimes(2);
    expect(onStepUp).toHaveBeenCalledWith({ code: 'REVERIFICATION_REQUIRED', level: 'second_factor', afterMinutes: 10 });
  });

  it('keeps the refusal when the person does not confirm, or nobody can ask', async () => {
    const send = vi.fn().mockResolvedValue(reverify('first_factor'));
    expect((await sendWithStepUp(send, vi.fn().mockResolvedValue(false))).status).toBe(403);
    expect((await sendWithStepUp(send)).status).toBe(403);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('asks nothing for another 403', async () => {
    const onStepUp = vi.fn();
    const response = await sendWithStepUp(() => Promise.resolve(json({ error: { code: 'FORBIDDEN' } }, 403)), onStepUp);
    expect(response.status).toBe(403);
    expect(onStepUp).not.toHaveBeenCalled();
  });
});

describe('createClientApi with onStepUp', () => {
  it('retries with the token of the new sign-in', async () => {
    const tokens = ['at-1', 'at-2'];
    const seen: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const auth = new Headers(init.headers).get('Authorization') ?? '';
        seen.push(auth);
        return auth === 'Bearer at-2' ? json({ data: { memberId: 'mem_1' } }, 201) : reverify('first_factor');
      }),
    );
    const api = createClientApi({
      getToken: () => Promise.resolve(tokens[seen.length] ?? null),
      baseUrl: 'https://api.example.test',
      onStepUp: confirmStepUp,
    });
    setStepUpHandler(() => Promise.resolve(true));
    await expect(api.post('/team-members/invite', { email: 'a@b.test' })).resolves.toEqual({ data: { memberId: 'mem_1' } });
    expect(seen).toEqual(['Bearer at-1', 'Bearer at-2']);
  });

  it('throws the refusal, with its code, when nobody confirms', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reverify('second_factor')));
    const api = createClientApi({ getToken: () => Promise.resolve('at-1'), baseUrl: 'https://api.example.test', onStepUp: confirmStepUp });
    const error = await api.delete('/workspace-api-keys/wak_1').catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(403);
    expect((error as ApiError).code).toBe('REVERIFICATION_REQUIRED');
  });
});
