/**
 * Pure helpers of the approvals screens (My reviews, change requests, the
 * baseline overlay): the decision form, the plain-words reason a reviewer was
 * asked, and the slip label.
 */

import { z } from 'zod';
import type { ApprovalAnswer, ReviewItem } from '@weldsuite/app-api-client/domains/flow-approvals';

/** Answers that need a comment: a decline says why, conditions say which. */
export const NOTE_REQUIRED: readonly ApprovalAnswer[] = ['rejected', 'approved_with_conditions'];

export function noteRequired(decision: ApprovalAnswer): boolean {
  return NOTE_REQUIRED.includes(decision);
}

/** The decision form: the answer, and a comment that a decline or conditions cannot go without. */
export function decideFormSchema(requiredMessage: string) {
  return z
    .object({
      decision: z.enum(['approved', 'approved_with_conditions', 'rejected', 'info_requested']),
      note: z.string().max(5000),
    })
    .superRefine((value, ctx) => {
      if (noteRequired(value.decision) && value.note.trim().length === 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['note'], message: requiredMessage });
      }
    });
}

export type DecideFormValues = z.infer<ReturnType<typeof decideFormSchema>>;

/** The answers a review offers: a time entry is only approved or declined. */
export function answersFor(review: Pick<ReviewItem, 'source'>): ApprovalAnswer[] {
  return review.source === 'timesheet'
    ? ['approved', 'rejected']
    : ['approved', 'approved_with_conditions', 'rejected', 'info_requested'];
}

interface RuleCopy {
  change_manager: string;
  change_manager_over: string;
  change_board_over_limit: string;
  gate: string;
  deliverable_sponsor: string;
  deliverable_client: string;
  decision: string;
  risk_acceptance: string;
  project_request: string;
  close: string;
  unknown: string;
  note: string;
}

type Format = (template: string, values: Record<string, string | number>) => string;

/** Why this person was asked, in words, from the rule code and the parameters the routing stored. */
export function ruleText(rule: ReviewItem['rule'], copy: RuleCopy, format: Format, money: (value: number) => string): string | null {
  if (!rule) return null;
  const params = rule.params ?? {};
  const num = (key: string): number | null => (typeof params[key] === 'number' ? (params[key] as number) : null);
  let text: string;
  switch (rule.code) {
    case 'change_manager':
      text = params.noBoard === true ? copy.change_manager_over : copy.change_manager;
      break;
    case 'change_board_over_limit':
      text = format(copy.change_board_over_limit, {
        cost: num('costDelta') === null ? '-' : money(num('costDelta') as number),
        days: num('scheduleDeltaDays') ?? 0,
      });
      break;
    case 'risk_acceptance':
      text = format(copy.risk_acceptance, { score: num('score') ?? '-' });
      break;
    case 'gate':
    case 'deliverable_sponsor':
    case 'deliverable_client':
    case 'decision':
    case 'project_request':
    case 'close':
      text = copy[rule.code];
      break;
    default:
      text = copy.unknown;
  }
  const note = typeof params.note === 'string' && params.note.trim() ? params.note.trim() : null;
  return note ? `${text} ${format(copy.note, { note })}` : text;
}

/** `+8d` for a slip, `-2d` for early, null for no movement or no figure. */
export function slipLabel(days: number | null | undefined): string | null {
  if (days === null || days === undefined || days === 0) return null;
  return days > 0 ? `+${days}d` : `${days}d`;
}

/** Count of items in a comparison that moved later than agreed. */
export function slippedCount(items: ReadonlyArray<{ deltaDays?: number | null; end?: { deltaDays: number | null } }>): number {
  return items.filter((item) => ((item.deltaDays ?? item.end?.deltaDays ?? 0) as number) > 0).length;
}
