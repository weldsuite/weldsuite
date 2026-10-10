/**
 * What an enrolled person is doing in a sequence, worked out from the
 * sequence's steps and the enrollment's `currentStepIndex`.
 *
 * The People tab used to label every active enrollment "Automated email", also
 * for a sequence whose only step is a delay. Pure functions, no i18n: the tab
 * maps the result to its own strings.
 */

import { getDelaySeconds } from '@/components/workflow-editor/lib/duration';

type StepBag = Record<string, unknown>;

export type StepKind = 'delay' | 'email' | 'condition' | 'other';

export type EnrollmentActivity =
  | { kind: 'waiting'; seconds: number }
  | { kind: 'email' }
  | { kind: 'condition' }
  | { kind: 'step'; name: string }
  | { kind: 'unknown' };

function toStep(value: unknown): StepBag | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as StepBag) : undefined;
}

export function getStepKind(step: unknown): StepKind {
  switch (toStep(step)?.type) {
    case 'delay':
      return 'delay';
    case 'send_email':
      return 'email';
    case 'condition':
      return 'condition';
    default:
      return 'other';
  }
}

/** The length of a delay step, in seconds (0 when it has none or it is not a delay). */
export function getStepDelaySeconds(step: unknown): number {
  const config = toStep(toStep(step)?.config);
  return getDelaySeconds(config);
}

export function getStepName(step: unknown): string {
  const name = toStep(step)?.name;
  return typeof name === 'string' ? name.trim() : '';
}

/**
 * The step an `active` enrollment is on. `currentStepIndex` is how many steps
 * its run has reached: 0 before the first, 1 once step 1 has been handed to the
 * engine. A delay is recorded BEFORE it sleeps, so index 1 can still mean
 * "sleeping in step 1". Hence: a delay it has reached is the one it is waiting
 * in; otherwise it is on the step after the last one reached, or on the last
 * one when it is past the end.
 */
export function getCurrentStep(steps: readonly unknown[], currentStepIndex: number): unknown {
  const reached = toStep(steps[currentStepIndex - 1]);
  if (getStepKind(reached) === 'delay') return reached;
  return toStep(steps[currentStepIndex]) ?? reached;
}

export function getEnrollmentActivity(steps: readonly unknown[], currentStepIndex: number): EnrollmentActivity {
  const step = getCurrentStep(steps, currentStepIndex);
  if (!step) return { kind: 'unknown' };
  switch (getStepKind(step)) {
    case 'delay':
      return { kind: 'waiting', seconds: getStepDelaySeconds(step) };
    case 'email':
      return { kind: 'email' };
    case 'condition':
      return { kind: 'condition' };
    default:
      return { kind: 'step', name: getStepName(step) };
  }
}
