/**
 * Pure helpers of the Close project page: the detail line of each check, what
 * still blocks sign-off, the status a closed register item gets, the lessons
 * board order, who may change a lesson, and the verdict on the final finance.
 */

import { RAID_CLOSED_STATUSES, RAID_KINDS } from '@weldsuite/app-api-client/schemas/project-control';
import type { RaidKind } from '@weldsuite/app-api-client/domains/project-control';
import type {
  CloseBenefit,
  CloseCheck,
  CloseChecklist,
  CloseCheckKey,
  CloseFinance,
  Lesson,
  LessonCategory,
} from '@weldsuite/app-api-client/domains/project-closing';
import type { UpdateRaidItemInput } from '@weldsuite/app-api-client/domains/project-control';
import type { TranslationsType } from '@weldsuite/i18n/types';
import type { PluralForms } from '@weldsuite/i18n/plural';

export type ClosingCopy = TranslationsType['flowClosing'];
export type CloseCopy = ClosingCopy['close'];
export type Plural = (count: number, forms: PluralForms) => string;
export type Format = (template: string, values: Record<string, unknown>) => string;

export const LESSON_COLUMNS: readonly LessonCategory[] = ['went_well', 'went_badly', 'do_differently'];

export function isRaidKind(kind: string): kind is RaidKind {
  return (RAID_KINDS as readonly string[]).includes(kind);
}

// ── Checklist ───────────────────────────────────────────────────────────────

/** The checks that block a sign-off request and are not done yet. */
export function openBlockingChecks(checks: readonly CloseCheck[]): CloseCheck[] {
  return checks.filter((check) => check.blocking && !check.done);
}

interface DetailContext {
  copy: CloseCopy;
  plural: Plural;
  format: Format;
  signOff: CloseChecklist['signOff'];
  /** The sponsor's name, when it is known. */
  sponsorName: string | null;
}

/** The detail line under a check, from its counts (and the sponsor for the sign-off). */
export function checkDetail(check: CloseCheck, ctx: DetailContext): string {
  const { copy, plural, format } = ctx;
  if (check.key === 'signoff') {
    const text = copy.checklist.checks.signoff;
    const sponsor = ctx.sponsorName;
    const state = ctx.signOff.state;
    if (state === 'pending') return sponsor ? format(text.pending, { sponsor }) : text.pendingNoSponsor;
    if (state === 'approved' || check.done) return sponsor ? format(text.approved, { sponsor }) : text.approvedNoSponsor;
    if (state === 'rejected') return sponsor ? format(text.rejected, { sponsor }) : text.rejectedNoSponsor;
    return sponsor ? format(text.none, { sponsor }) : text.noneNoSponsor;
  }
  const text = copy.checklist.checks[check.key as Exclude<CloseCheckKey, 'signoff'>];
  if (check.total === 0) return text.none;
  const forms = text.progress;
  return format(plural(check.total, forms), { satisfied: check.satisfied, total: check.total });
}

// ── Register items ──────────────────────────────────────────────────────────

/** The status that closes an item of a kind: `validated` for an assumption, `closed` for the rest. */
export function raidClosedStatus(kind: RaidKind): string {
  const closed = RAID_CLOSED_STATUSES[kind] as readonly string[];
  return kind === 'assumption' ? 'validated' : closed.includes('closed') ? 'closed' : closed[0];
}

/** The PATCH body that closes an item. */
export function raidCloseBody(kind: RaidKind): UpdateRaidItemInput {
  return { status: raidClosedStatus(kind) } as UpdateRaidItemInput;
}

// ── Benefits ────────────────────────────────────────────────────────────────

export function benefitNeeds(benefit: Pick<CloseBenefit, 'ownerId' | 'latest'>): { owner: boolean; measurement: boolean } {
  return { owner: benefit.ownerId === null, measurement: benefit.latest === null };
}

// ── Lessons ─────────────────────────────────────────────────────────────────

/** Most votes first, then oldest first, as the server orders a published page. */
export function sortLessons(lessons: readonly Lesson[]): Lesson[] {
  return [...lessons].sort(
    (a, b) => b.voteCount - a.voteCount || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
}

export function lessonsByCategory(lessons: readonly Lesson[]): Record<LessonCategory, Lesson[]> {
  const sorted = sortLessons(lessons);
  return {
    went_well: sorted.filter((lesson) => lesson.category === 'went_well'),
    went_badly: sorted.filter((lesson) => lesson.category === 'went_badly'),
    do_differently: sorted.filter((lesson) => lesson.category === 'do_differently'),
  };
}

/** The API lets a lesson's author and a project manager change it. */
export function canChangeLesson(lesson: Pick<Lesson, 'authorId'>, userId: string | null, isManager: boolean): boolean {
  return isManager || (userId !== null && lesson.authorId === userId);
}

// ── Finance ─────────────────────────────────────────────────────────────────

export interface FinanceVerdict {
  kind: 'over' | 'under' | 'on' | 'none';
  /** The size of the difference as a percentage of the budget, without sign. */
  percent: number | null;
  /** The size of the difference as a decimal string, without sign; null when the amounts are hidden. */
  amount: string | null;
}

export function financeVerdict(finance: CloseFinance): FinanceVerdict {
  const variance = finance.variance === null ? null : Number(finance.variance);
  const amount = variance === null || Number.isNaN(variance) ? null : String(Math.abs(variance));
  const percent = finance.variancePercent === null ? null : Math.abs(finance.variancePercent);
  if (finance.overBudget) return { kind: 'over', percent, amount };
  if (finance.variancePercent !== null) {
    if (finance.variancePercent < 0) return { kind: 'under', percent, amount };
    return { kind: 'on', percent, amount };
  }
  if (variance !== null && !Number.isNaN(variance)) {
    return { kind: variance < 0 ? 'under' : 'on', percent, amount };
  }
  return { kind: 'none', percent: null, amount: null };
}

// ── Formatting ──────────────────────────────────────────────────────────────

/** A decimal string as money: no decimals for a whole amount; the plain number when the currency is unknown. */
export function formatMoney(value: string | number | null, currency: string | null, intlLocale: string): string {
  if (value === null) return '—';
  const number = Number(value);
  if (Number.isNaN(number)) return '—';
  const digits = Number.isInteger(number) ? 0 : 2;
  try {
    if (currency) {
      return new Intl.NumberFormat(intlLocale, {
        style: 'currency',
        currency,
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      }).format(number);
    }
  } catch {
    // An unknown currency code falls through to the plain number.
  }
  const plain = new Intl.NumberFormat(intlLocale, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(number);
  return currency ? `${plain} ${currency}` : plain;
}

/** A numeric column value (up to 4 decimals, trailing zeros dropped), with its unit. */
export function formatMeasure(value: string | null, unit: string | null, intlLocale: string): string {
  if (value === null) return '—';
  const number = Number(value);
  if (Number.isNaN(number)) return value;
  const text = new Intl.NumberFormat(intlLocale, { maximumFractionDigits: 4 }).format(number);
  return unit ? `${text} ${unit}` : text;
}

export function formatPercent(value: number, intlLocale: string): string {
  return `${new Intl.NumberFormat(intlLocale, { maximumFractionDigits: 1 }).format(value)}%`;
}

/** `2027-02` as "Feb 2027". */
export function formatPeriod(period: string, intlLocale: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(period);
  if (!match) return period;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1));
  return new Intl.DateTimeFormat(intlLocale, { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(date);
}

/** A timestamp as a date in the user's language. */
export function formatDay(iso: string | null, intlLocale: string): string {
  if (!iso) return '';
  return new Intl.DateTimeFormat(intlLocale, { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso));
}
