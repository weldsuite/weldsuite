/**
 * Step-up for sensitive actions. The API refuses a sensitive action with a 403
 * when the session's sign-in or second factor is too old:
 *
 *   { error: { code: 'MFA_REQUIRED' } }
 *   { error: { code: 'REVERIFICATION_REQUIRED', details: { level, afterMinutes } } }
 *
 * `MFA_REQUIRED`: the action needs a second factor and the session has none.
 * `REVERIFICATION_REQUIRED`: confirm `level` again (`first_factor`, a sign-in;
 * `second_factor`, the authenticator app, passkey or recovery code).
 *
 * A client that can ask the user to confirm passes `onStepUp`; when it
 * resolves `true` the request is sent once more, with a fresh token.
 */

export const MFA_REQUIRED = 'MFA_REQUIRED';
export const REVERIFICATION_REQUIRED = 'REVERIFICATION_REQUIRED';

export type StepUpLevel = 'first_factor' | 'second_factor';

export interface StepUpChallenge {
  code: typeof MFA_REQUIRED | typeof REVERIFICATION_REQUIRED;
  /** What to confirm. `MFA_REQUIRED` is always `second_factor`. */
  level: StepUpLevel;
  /** How recent the confirmation must be, when the server says. */
  afterMinutes: number | null;
}

/** Asks the user to confirm; `true` when they did and the request may be sent again. */
export type StepUpHandler = (challenge: StepUpChallenge) => Promise<boolean>;

/** The step-up a refused response asks for, or null for any other answer. */
export function stepUpChallengeOf(status: number, body: unknown): StepUpChallenge | null {
  if (status !== 403 || !body || typeof body !== 'object') return null;
  const error = (body as { error?: unknown }).error;
  if (!error || typeof error !== 'object') return null;
  const { code, details } = error as { code?: unknown; details?: unknown };
  if (code === MFA_REQUIRED) return { code, level: 'second_factor', afterMinutes: null };
  if (code !== REVERIFICATION_REQUIRED) return null;
  const { level, afterMinutes } = (details && typeof details === 'object' ? details : {}) as {
    level?: unknown;
    afterMinutes?: unknown;
  };
  return {
    code,
    level: level === 'first_factor' ? 'first_factor' : 'second_factor',
    afterMinutes: typeof afterMinutes === 'number' ? afterMinutes : null,
  };
}

/**
 * Sends `send()`. When the answer asks for step-up and `onStepUp` resolves
 * `true`, sends it once more (`send` builds its headers again, so the retry
 * carries the token of the new sign-in). Otherwise the first answer stands.
 */
export async function sendWithStepUp(send: () => Promise<Response>, onStepUp?: StepUpHandler): Promise<Response> {
  const response = await send();
  if (response.status !== 403 || !onStepUp) return response;
  const body: unknown = await response
    .clone()
    .json()
    .catch(() => null);
  const challenge = stepUpChallengeOf(response.status, body);
  if (!challenge) return response;
  return (await onStepUp(challenge)) ? send() : response;
}
