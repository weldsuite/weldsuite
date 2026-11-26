import { describe, expect, it, vi } from 'vitest';
import { MFA_REQUIRED, REVERIFICATION_REQUIRED, sendWithStepUp, stepUpChallengeOf } from './step-up.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const reverify = (level: string) =>
  json({ error: { code: REVERIFICATION_REQUIRED, message: 'Confirm', details: { level, afterMinutes: 10 } } }, 403);

describe('stepUpChallengeOf', () => {
  it('reads what the API asks to confirm', () => {
    expect(stepUpChallengeOf(403, { error: { code: MFA_REQUIRED } })).toEqual({
      code: MFA_REQUIRED,
      level: 'second_factor',
      afterMinutes: null,
    });
    expect(
      stepUpChallengeOf(403, { error: { code: REVERIFICATION_REQUIRED, details: { level: 'first_factor', afterMinutes: 10 } } }),
    ).toEqual({ code: REVERIFICATION_REQUIRED, level: 'first_factor', afterMinutes: 10 });
  });

  it('takes a refusal without details as the second factor (Clerk, books-api)', () => {
    expect(stepUpChallengeOf(403, { error: { code: REVERIFICATION_REQUIRED } })).toEqual({
      code: REVERIFICATION_REQUIRED,
      level: 'second_factor',
      afterMinutes: null,
    });
    expect(stepUpChallengeOf(403, { error: { code: REVERIFICATION_REQUIRED, details: 'stale' } })?.level).toBe('second_factor');
  });

  it('ignores every other answer', () => {
    expect(stepUpChallengeOf(403, { error: { code: 'FORBIDDEN' } })).toBeNull();
    expect(stepUpChallengeOf(401, { error: { code: REVERIFICATION_REQUIRED } })).toBeNull();
    expect(stepUpChallengeOf(403, { error: 'Forbidden' })).toBeNull();
    expect(stepUpChallengeOf(403, null)).toBeNull();
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
    expect(onStepUp).toHaveBeenCalledWith({ code: REVERIFICATION_REQUIRED, level: 'second_factor', afterMinutes: 10 });
  });

  it('keeps the refusal when the person does not confirm, or nobody can ask', async () => {
    const refused = vi.fn().mockResolvedValue(reverify('first_factor'));
    expect((await sendWithStepUp(refused, vi.fn().mockResolvedValue(false))).status).toBe(403);
    expect((await sendWithStepUp(refused)).status).toBe(403);
    expect(refused).toHaveBeenCalledTimes(2);
  });

  it('asks nothing for another answer', async () => {
    const onStepUp = vi.fn();
    expect((await sendWithStepUp(() => Promise.resolve(json({ error: { code: 'FORBIDDEN' } }, 403)), onStepUp)).status).toBe(403);
    expect((await sendWithStepUp(() => Promise.resolve(new Response('not json', { status: 403 })), onStepUp)).status).toBe(403);
    expect((await sendWithStepUp(() => Promise.resolve(json({ data: [] })), onStepUp)).status).toBe(200);
    expect(onStepUp).not.toHaveBeenCalled();
  });
});
