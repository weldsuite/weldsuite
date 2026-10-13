export const SETUP_STEPS = ['identity', 'payment', 'domains', 'mailboxes', 'done'] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];

export function parseSetupStep(value: unknown): SetupStep | null {
  return typeof value === 'string' && (SETUP_STEPS as readonly string[]).includes(value) ? (value as SetupStep) : null;
}
