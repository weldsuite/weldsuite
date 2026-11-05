/**
 * Pure helpers of the intake pages: money, needed skills typed as text,
 * payback, status colours and where a lane sits on the roadmap.
 */

import type {
  NeededSkillInput,
  ProjectRequest,
  ProjectRequestStatus,
  ScoringCriterionInput,
} from '@weldsuite/app-api-client/domains/flow-portfolio';

export const STATUS_CLASS: Record<ProjectRequestStatus, string> = {
  new: 'bg-muted text-foreground/80',
  assessing: 'bg-blue-100 text-blue-900 dark:bg-blue-950 dark:text-blue-200',
  approved: 'bg-green-100 text-green-900 dark:bg-green-950 dark:text-green-200',
  rejected: 'bg-neutral-200 text-neutral-800 dark:bg-neutral-800 dark:text-neutral-200',
  converted: 'bg-violet-100 text-violet-900 dark:bg-violet-950 dark:text-violet-200',
};

/** A money amount ("140000.00") in the user's language, no decimals; "–" when empty. */
export function formatMoney(amount: string | null, locale: string): string {
  if (amount === null) return '–';
  return new Intl.NumberFormat(locale, { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(Number(amount));
}

/** Months until the yearly value covers the cost, null without both. */
export function paybackMonths(cost: string | null, value: string | null): number | null {
  const c = cost === null ? 0 : Number(cost);
  const v = value === null ? 0 : Number(value);
  return c > 0 && v > 0 ? Math.round((c / v) * 12) : null;
}

/** "Backend 24, PM 8" as needed skills: a trailing number is the hours per week. */
export function parseNeededSkills(text: string): NeededSkillInput[] {
  const out: NeededSkillInput[] = [];
  for (const part of text.split(',')) {
    const trimmed = part.trim();
    const last = trimmed.split(/\s+/).pop() ?? '';
    const hasHours = last !== trimmed && /^\d+(?:[.,]\d+)?$/.test(last);
    const skill = (hasHours ? trimmed.slice(0, trimmed.length - last.length) : trimmed).trim();
    if (!skill) continue;
    const hours = hasHours ? Number(last.replace(',', '.')) : undefined;
    out.push(hours && hours >= 0.01 && hours <= 168 ? { skill, hoursPerWeek: hours } : { skill });
  }
  return out;
}

/** Needed skills as the text a person edits. */
export function needsText(needs: readonly NeededSkillInput[]): string {
  return needs.map((n) => (n.hoursPerWeek === undefined ? n.skill : `${n.skill} ${n.hoursPerWeek}`)).join(', ');
}

/** The ranked table: rejected and converted requests only when asked for. */
export function visibleRequests(requests: readonly ProjectRequest[], showRejected: boolean): ProjectRequest[] {
  return requests.filter((r) => r.status !== 'converted' && (showRejected || r.status !== 'rejected'));
}

/** The sum of the weights of a model. */
export function weightTotal(model: readonly ScoringCriterionInput[]): number {
  return model.reduce((sum, c) => sum + c.weight, 0);
}

/** Where a bar from `startsOn` to `endsOn` sits in `[from, to]`, as left and width percentages. */
export function lanePosition(startsOn: string, endsOn: string, from: string, to: string): { left: number; width: number } {
  const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
  const total = day(to) - day(from) + 86_400_000;
  const start = Math.max(day(startsOn), day(from));
  const end = Math.min(day(endsOn) + 86_400_000, day(to) + 86_400_000);
  const left = ((start - day(from)) / total) * 100;
  const width = Math.max(((end - start) / total) * 100, 1.5);
  return { left: Math.round(left * 100) / 100, width: Math.round(Math.min(width, 100 - left) * 100) / 100 };
}

/** An optional money amount: digits with at most two decimals, so "140,000" is refused instead of read as 140. */
export const AMOUNT = /^(\d+([.,]\d{1,2})?)?$/;

/** Reads an amount field: empty is null, a comma counts as the decimal point. */
export const amount = (text: string): number | null => (text.trim() === '' ? null : Number(text.trim().replace(',', '.')));
