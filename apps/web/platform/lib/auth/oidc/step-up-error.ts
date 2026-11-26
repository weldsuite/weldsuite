/**
 * Step-up's types, apart from the session so the facade can re-export them
 * without loading `oidc-client-ts` (as `browser-sign-in.ts`).
 */

/** What a step-up confirms again: a sign-in, or the second factor too. */
export type StepUpLevel = 'first_factor' | 'second_factor';

/** Why a step-up ended without a new sign-in of the same person. */
export class StepUpError extends Error {
  readonly reason: 'cancelled' | 'other_account' | 'failed';

  constructor(reason: StepUpError['reason']) {
    super(`Confirming your identity ended: ${reason}`);
    this.name = 'StepUpError';
    this.reason = reason;
  }
}
