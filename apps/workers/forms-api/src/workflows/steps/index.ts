/**
 * The ordered steps of ProcessResponse (weldsuite-documentation/plans/weldforms.md, "Submitting and
 * ProcessResponse"). One idempotent step per enabled integration, then
 * notifications and the receipt email.
 *
 * Adding a step is one file: implement `ProcessStep` (./types.ts) in its own
 * module here and list it below. The workflow does the rest: it runs each as its
 * own Workflow step, so a failing one retries with backoff without repeating the
 * others, and it records integration steps in `form_response_actions`.
 */

import { crmStep } from './crm';
import { deskStep } from './desk';
import { flowStep } from './flow';
import { notifyStep } from './notify';
import { quotaStep } from './quota';
import { receiptStep } from './receipt';
import type { ProcessStep } from './types';

export const PROCESS_STEPS: readonly ProcessStep[] = [
  // The integrations: one run per enabled integration of the kind, as the member who set it up.
  crmStep,
  deskStep,
  flowStep,
  // Then the people: followers, the respondent's copy, the quota notices.
  notifyStep,
  receiptStep,
  quotaStep,
];

export type { ProcessStep, ProcessContext, StepResult } from './types';
