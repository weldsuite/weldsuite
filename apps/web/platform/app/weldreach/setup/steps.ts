export const SETUP_STEPS = ['identity', 'payment', 'domains', 'mailboxes', 'done'] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];

/**
 * The wizard's steps. Without billing (the Kubernetes editions, or a backend
 * that reports no subscription) mailboxes are not charged, so there is no
 * payment step.
 */
export function setupSteps(billed: boolean): readonly SetupStep[] {
  return billed ? SETUP_STEPS : SETUP_STEPS.filter((step) => step !== 'payment');
}

export function parseSetupStep(value: unknown, steps: readonly SetupStep[] = SETUP_STEPS): SetupStep | null {
  return typeof value === 'string' && (steps as readonly string[]).includes(value) ? (value as SetupStep) : null;
}
