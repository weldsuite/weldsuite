/**
 * Step-up for the platform's API clients (ADR SEC-022). Every client passes
 * `confirmStepUp` as `onStepUp`: when the API refuses a sensitive action with
 * `MFA_REQUIRED` / `REVERIFICATION_REQUIRED`, the mounted `StepUpDialogHost`
 * asks the person to confirm their identity, and the request goes out once
 * more. Without a host (Clerk, where the bank-feed link keeps Clerk's own
 * dialog, or before the shell mounts) the refusal is thrown as before.
 */

import type { StepUpChallenge, StepUpHandler } from '@weldsuite/api-client/step-up';

let handler: StepUpHandler | null = null;

/** Installed by `StepUpDialogHost` while it is mounted; `null` removes it. */
export function setStepUpHandler(next: StepUpHandler | null): void {
  handler = next;
}

/** The clients' `onStepUp`: true once the person confirmed, false when they didn't or nobody can ask. */
export function confirmStepUp(challenge: StepUpChallenge): Promise<boolean> {
  return handler ? handler(challenge) : Promise.resolve(false);
}
