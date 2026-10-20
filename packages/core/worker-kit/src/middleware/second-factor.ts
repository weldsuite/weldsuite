/**
 * Step-up authentication for sensitive actions: the caller must have verified
 * a second factor (authenticator app, backup code) in this session within the
 * last `maxAgeMinutes`, read from Clerk's `fva` claim (clerkMiddleware).
 *
 * Unlike Clerk's own reverification check, this never falls back to the first
 * factor for a user without a second factor: such a user is refused with
 * MFA_REQUIRED and has to set one up first. A stale second factor gets
 * REVERIFICATION_REQUIRED, which the client answers by letting the user confirm
 * it again (Clerk's `useReverification`) and retrying.
 *
 *   403 { error: { code: 'MFA_REQUIRED' } }
 *   403 { error: { code: 'REVERIFICATION_REQUIRED', details: { level: 'second_factor', afterMinutes } } }
 */

import { createMiddleware } from 'hono/factory';

export const MFA_REQUIRED = 'MFA_REQUIRED';
export const REVERIFICATION_REQUIRED = 'REVERIFICATION_REQUIRED';

/** Clerk's `strict` window. */
export const DEFAULT_SECOND_FACTOR_MAX_AGE_MINUTES = 10;

type SecondFactorVariables = { factorVerificationAge?: readonly [number, number] | null };

export type SecondFactorCheck = 'pass' | typeof MFA_REQUIRED | typeof REVERIFICATION_REQUIRED;

export function checkSecondFactor(
  factorVerificationAge: readonly [number, number] | null | undefined,
  maxAgeMinutes: number = DEFAULT_SECOND_FACTOR_MAX_AGE_MINUTES,
): SecondFactorCheck {
  if (!factorVerificationAge) return REVERIFICATION_REQUIRED;
  const secondFactorAge = factorVerificationAge[1];
  if (secondFactorAge === -1) return MFA_REQUIRED;
  return secondFactorAge < maxAgeMinutes ? 'pass' : REVERIFICATION_REQUIRED;
}

export const requireSecondFactor = (options: { maxAgeMinutes?: number } = {}) => {
  const maxAgeMinutes = options.maxAgeMinutes ?? DEFAULT_SECOND_FACTOR_MAX_AGE_MINUTES;
  return createMiddleware<{ Variables: SecondFactorVariables }>(async (c, next) => {
    const result = checkSecondFactor(c.get('factorVerificationAge'), maxAgeMinutes);
    if (result === MFA_REQUIRED) {
      return c.json(
        { error: { code: MFA_REQUIRED, message: 'Set up two-step verification on your account to do this.' } },
        403,
      );
    }
    if (result === REVERIFICATION_REQUIRED) {
      return c.json(
        {
          error: {
            code: REVERIFICATION_REQUIRED,
            message: 'Confirm your identity with your second factor to do this.',
            details: { level: 'second_factor', afterMinutes: maxAgeMinutes },
          },
        },
        403,
      );
    }
    await next();
  });
};
