/** Pure helpers behind the sequence editor: step drafts and template variables. */

import {
  REACH_TEMPLATE_VARIABLES,
  type ReachCampaignStep,
  type ReachStepInput,
} from '@weldsuite/app-api-client/schemas/reach';

/** The most steps a campaign takes (the contract's `replaceReachStepsSchema` limit). */
export const MAX_STEPS = 10;

/** A follow-up added with "Add step". */
export function newStep(): ReachStepInput {
  return { delayDays: 3, delayHours: 0, subject: '', body: '', replyInThread: true };
}

/** The editor's starting point: the stored steps in sending order. */
export function stepsToDraft(steps: ReachCampaignStep[]): ReachStepInput[] {
  if (steps.length === 0) return [{ ...newStep(), delayDays: 0, replyInThread: false }];
  return [...steps]
    .sort((a, b) => a.order - b.order)
    .map((step) => ({
      delayDays: step.delayDays,
      delayHours: step.delayHours,
      subject: step.subject,
      body: step.body,
      replyInThread: step.replyInThread,
    }));
}

/**
 * What gets saved: the first email goes out right away, so it has no delay
 * (the editor hides those fields, and a reorder can leave a stale value there).
 */
export function normalizeSteps(steps: ReachStepInput[]): ReachStepInput[] {
  return steps.map((step, index) =>
    index === 0 ? { ...step, delayDays: 0, delayHours: 0 } : step,
  );
}

const VARIABLE_PATTERN = /\{\{\s*([a-zA-Z0-9_.-]+)\s*(?:\|[^}]*)?\}\}/g;

/** Variable names used in `text`, in order of first use, without repeats. */
export function templateVariables(text: string): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(VARIABLE_PATTERN)) {
    const name = match[1];
    if (name) names.add(name);
  }
  return [...names];
}

/** Variables in `texts` that are neither built in nor a known custom field. */
export function unknownVariables(texts: string[], customFieldNames: string[]): string[] {
  const known = new Set<string>([...REACH_TEMPLATE_VARIABLES, ...customFieldNames]);
  const unknown = new Set<string>();
  for (const text of texts) {
    for (const name of templateVariables(text)) {
      if (!known.has(name)) unknown.add(name);
    }
  }
  return [...unknown];
}

/** `{{name}}` placeholder for a variable. */
export function variableToken(name: string): string {
  return `{{${name}}}`;
}

/** Inserts `insertion` over the selection and reports where the cursor belongs afterwards. */
export function insertAtSelection(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  insertion: string,
): { value: string; cursor: number } {
  const start = Math.max(0, Math.min(selectionStart, value.length));
  const end = Math.max(start, Math.min(selectionEnd, value.length));
  return {
    value: value.slice(0, start) + insertion + value.slice(end),
    cursor: start + insertion.length,
  };
}

/** Custom field names across the given prospects, sorted, without repeats. */
export function customFieldNames(prospects: Array<{ customFields: Record<string, string> }>): string[] {
  const names = new Set<string>();
  for (const prospect of prospects) {
    for (const name of Object.keys(prospect.customFields)) names.add(name);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}
