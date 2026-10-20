/**
 * Starting a bank link takes a second factor verified in the last few minutes
 * (books-api `requireSecondFactor`). When books-api answers
 * REVERIFICATION_REQUIRED, Clerk's own dialog asks for the second factor and
 * the call is made again. MFA_REQUIRED (no second factor set up) is not
 * handled here: there is nothing to confirm, the user has to set one up first.
 *
 * Kept apart from the connect hook so the bank feed tests can replace it
 * without a ClerkProvider.
 */
import { useCallback } from 'react';
import { useReverification } from '@clerk/clerk-react';
import { isBankFeedRequestError } from '@/lib/api/domains/weldbooks-bank-feeds';

export const MFA_REQUIRED = 'MFA_REQUIRED';
export const REVERIFICATION_REQUIRED = 'REVERIFICATION_REQUIRED';

/** Where users set up an authenticator app. */
export const SECURITY_SETTINGS_PATH = '/settings/security';

/** The hint `useReverification` answers with Clerk's verification dialog. */
const secondFactorHint = {
  clerk_error: {
    type: 'forbidden',
    reason: 'reverification-error',
    metadata: { reverification: { level: 'second_factor', afterMinutes: 10 } },
  },
} as const;

type Hint = typeof secondFactorHint;

function isHint(value: unknown): value is Hint {
  return Boolean(value && typeof value === 'object' && 'clerk_error' in value);
}

/** Still refused after the user confirmed: shown like any other books-api error. */
function stillRefused(): Error {
  return Object.assign(new Error('Second factor confirmation was not accepted'), {
    status: 403,
    code: REVERIFICATION_REQUIRED,
  });
}

/**
 * `call`, with the user asked to confirm their second factor when books-api
 * wants a fresh one. A cancelled confirmation rejects with Clerk's
 * `reverification_cancelled` error (`isReverificationCancelledError`).
 */
export function useWithSecondFactor<A extends unknown[], R>(call: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  const verified = useReverification(async (...args: A): Promise<R | Hint> => {
    try {
      return await call(...args);
    } catch (err) {
      if (isBankFeedRequestError(err) && err.code === REVERIFICATION_REQUIRED) return secondFactorHint;
      throw err;
    }
  });

  return useCallback(
    async (...args: A) => {
      const result = await verified(...args);
      if (isHint(result)) throw stillRefused();
      return result as R;
    },
    [verified],
  );
}
