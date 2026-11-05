/**
 * Closing a project: lessons learned and the close checklist (design:
 * weldflow-delivery-and-portfolio.md, "Close a project"; slice F).
 *
 * Pure functions, no database and no Hono context. flow-api's
 * `/api/project-lessons` and `/api/project-close` routes use them, and the Rust
 * flow-domain mirrors them. Every message returned here is sent to the client
 * as it is, so the two backends answer alike.
 */

import type { schema } from '@weldsuite/worker-kit/db';
import {
  LESSON_CATEGORIES,
  type CloseCheck,
  type CloseCheckKey,
  type CloseFinance,
  type CloseSignOff,
  type Lesson,
  type LessonCategory,
  type LessonPageLocale,
} from '@weldsuite/app-api-client/schemas/project-closing';
import { compareText } from './compare';

export { LESSON_CATEGORIES };
export type { LessonCategory, LessonPageLocale };

type LessonRow = typeof schema.projectLessons.$inferSelect;

/** The messages of every refusal the closing routes answer with a rule of their own. */
export const CLOSING_MESSAGES = {
  lessonNotFound: 'Lesson',
  noLessons: 'There are no lessons to publish',
  notAuthor: 'Only the author of a lesson or a project manager can change it',
  alreadyClosed: 'This project is already closed',
  checklistOpen: 'Finish the open checks before asking for sign-off',
  alreadyRequested: 'Sign-off has already been requested',
  noSponsor: 'The project has no sponsor or project manager to ask for sign-off',
  nothingToHandOver: 'Choose at least one item to hand over',
  handoverRaidItem: 'RAID item not found, or no longer open, in this project',
  handoverBenefit: 'Benefit not found, or already closed, in this project',
} as const;

// ── Lessons ─────────────────────────────────────────────────────────────────

/** The member ids that voted for a lesson. */
export function votesOf(row: Pick<LessonRow, 'votes'>): string[] {
  return Array.isArray(row.votes) ? row.votes.filter((vote): vote is string => typeof vote === 'string') : [];
}

/** A lesson as the routes answer it: the votes counted, and whether the caller is one of them. */
export function presentLesson(row: LessonRow, userId: string | null | undefined): Lesson {
  const votes = votesOf(row);
  return {
    id: row.id,
    projectId: row.projectId,
    category: row.category,
    text: row.text,
    authorId: row.authorId,
    voteCount: votes.length,
    votedByMe: !!userId && votes.includes(userId),
    knowPageId: row.knowPageId,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The payload of a `project_lesson` event: ids and counts, no free text. */
export function lessonEventData(row: LessonRow) {
  return {
    id: row.id,
    projectId: row.projectId,
    category: row.category,
    authorId: row.authorId,
    voteCount: votesOf(row).length,
    knowPageId: row.knowPageId,
  };
}

/** May this person edit or delete the lesson: its author, or someone who manages the project. */
export function mayChangeLesson(row: Pick<LessonRow, 'authorId'>, userId: string | null | undefined, canManage: boolean): boolean {
  return canManage || (!!userId && row.authorId === userId);
}

/** The headings of a published page, per language. */
export const LESSON_PAGE_TEXT: Record<
  LessonPageLocale,
  { title: (projectName: string) => string; categories: Record<LessonCategory, string>; votes: (count: number) => string }
> = {
  en: {
    title: (projectName) => `Lessons learned: ${projectName}`,
    categories: { went_well: 'Went well', went_badly: "Didn't go well", do_differently: 'Do differently' },
    votes: (count) => `${count} ${count === 1 ? 'vote' : 'votes'}`,
  },
  nl: {
    title: (projectName) => `Geleerde lessen: ${projectName}`,
    categories: { went_well: 'Ging goed', went_badly: 'Ging niet goed', do_differently: 'Anders doen' },
    votes: (count) => `${count} ${count === 1 ? 'stem' : 'stemmen'}`,
  },
};

/** The page title: the given one, else the default for the language, at most 500 characters. */
export function lessonsPageTitle(projectName: string, locale: LessonPageLocale, given?: string): string {
  const title = given && given.length > 0 ? given : LESSON_PAGE_TEXT[locale].title(projectName);
  return title.slice(0, 500);
}

/** Most votes first, then oldest first, then by id: the order of a category on the board and on the page. */
export function compareLessons(a: LessonRow, b: LessonRow): number {
  const byVotes = votesOf(b).length - votesOf(a).length;
  if (byVotes !== 0) return byVotes;
  const byTime = a.createdAt.getTime() - b.createdAt.getTime();
  if (byTime !== 0) return byTime;
  return compareText(a.id, b.id);
}

export type LessonBlock = Record<string, unknown>;

/**
 * The BlockNote blocks of the published page: a level-2 heading per category
 * that has lessons, then one bullet per lesson, most votes first, with its
 * votes in brackets when it has any.
 */
export function lessonBlocks(rows: readonly LessonRow[], locale: LessonPageLocale): LessonBlock[] {
  const text = LESSON_PAGE_TEXT[locale];
  const blocks: LessonBlock[] = [];
  for (const category of LESSON_CATEGORIES) {
    const lessons = rows.filter((row) => row.category === category).sort(compareLessons);
    if (lessons.length === 0) continue;
    blocks.push({
      type: 'heading',
      props: { level: 2 },
      content: [{ type: 'text', text: text.categories[category], styles: {} }],
      children: [],
    });
    for (const lesson of lessons) {
      const votes = votesOf(lesson).length;
      const line = votes > 0 ? `${lesson.text} (${text.votes(votes)})` : lesson.text;
      blocks.push({ type: 'bulletListItem', content: [{ type: 'text', text: line, styles: {} }], children: [] });
    }
  }
  return blocks;
}

// ── The close checklist ─────────────────────────────────────────────────────

/** What the checklist counts, read from the project's tables. */
export interface CloseCounts {
  closed: boolean;
  deliverables: { total: number; accepted: number };
  /** Change requests still in draft, assessing or awaiting approval. */
  changes: { total: number; open: number };
  /** Open register items, and how many of them were handed over. */
  raid: { open: number; handedOver: number };
  /** Benefits not closed yet, and how many have an owner and a measurement. */
  benefits: { total: number; ready: number };
  /** Time entries, and how many are still draft or submitted. */
  time: { total: number; open: number };
  lessons: { total: number; published: number };
  signOff: CloseSignOff['state'];
}

/** The checks that have to be done before sign-off can be requested. */
const BLOCKING: ReadonlySet<CloseCheckKey> = new Set(['deliverables', 'changes', 'raid', 'benefits', 'time']);

function checkState(done: boolean, waiting: boolean): CloseCheck['state'] {
  if (done) return 'done';
  return waiting ? 'waiting' : 'open';
}

function check(key: CloseCheckKey, total: number, satisfied: number, done: boolean, waiting = false): CloseCheck {
  return {
    key,
    blocking: BLOCKING.has(key),
    done,
    state: checkState(done, waiting),
    total,
    satisfied,
  };
}

/** The close checklist, in the order the page lists it. */
export function closeChecks(counts: CloseCounts): CloseCheck[] {
  const { deliverables, changes, raid, benefits, time, lessons } = counts;
  const signedOff = counts.closed || counts.signOff === 'approved';
  return [
    check('deliverables', deliverables.total, deliverables.accepted, deliverables.accepted === deliverables.total),
    check('changes', changes.total, changes.total - changes.open, changes.open === 0),
    check('raid', raid.open, raid.handedOver, raid.handedOver >= raid.open),
    check('benefits', benefits.total, benefits.ready, benefits.ready === benefits.total),
    check('time', time.total, time.total - time.open, time.open === 0),
    check('lessons', lessons.total, lessons.published, lessons.total > 0 && lessons.published === lessons.total),
    check('signoff', 0, 0, signedOff, counts.signOff === 'pending'),
  ];
}

/** Done checks out of all of them. */
export function closeProgress(checks: readonly CloseCheck[]): { done: number; total: number } {
  return { done: checks.filter((entry) => entry.done).length, total: checks.length };
}

/**
 * Sign-off can be requested: the project is open, every blocking check is
 * done, and no request is waiting for an answer.
 */
export function canRequestClose(checks: readonly CloseCheck[], closed: boolean, signOff: CloseSignOff['state']): boolean {
  if (closed || signOff === 'pending') return false;
  return checks.every((entry) => !entry.blocking || entry.done);
}

/** What the approval rows of the close request add up to: none, waiting, approved or declined. */
export function signOffState(decisions: readonly string[]): CloseSignOff['state'] {
  if (decisions.length === 0) return 'none';
  if (decisions.includes('rejected')) return 'rejected';
  if (decisions.every((decision) => decision === 'approved' || decision === 'approved_with_conditions')) return 'approved';
  return 'pending';
}

// ── Final finance ───────────────────────────────────────────────────────────

/** Rounds half away from zero, as the Rust port does. */
function roundHalfAway(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

function amountOf(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

const fixed2 = (value: number): string => value.toFixed(2);

export interface CloseFinanceInput {
  currency: string | null;
  amountsVisible: boolean;
  /** The budget on the latest baseline, else the project's budgeted amount. */
  budget: string | null;
  /** Cost of the approved and billed time entries. */
  timeCost: string;
  snapshot: { week: string; actualCost: string; committed: string; forecast: string | null } | null;
  baseline: { version: number; goLive: Date | null } | null;
}

/**
 * Final cost against budget. The actual cost is the latest finance snapshot's
 * when one was written (it counts every cost source), else the approved time
 * cost. Without `projects:finance` (and not a manager) the amounts are left
 * out and only the percentage and the verdict remain.
 */
export function closeFinance(input: CloseFinanceInput): CloseFinance {
  const budget = amountOf(input.budget);
  const actual = input.snapshot ? (amountOf(input.snapshot.actualCost) ?? 0) : (amountOf(input.timeCost) ?? 0);
  const variance = budget === null ? null : actual - budget;
  const variancePercent = variance === null || budget === null || budget <= 0 ? null : roundHalfAway((variance / budget) * 1000) / 10;
  const show = input.amountsVisible;
  return {
    currency: input.currency,
    amountsVisible: show,
    budget: show && budget !== null ? fixed2(budget) : null,
    timeCost: show ? fixed2(amountOf(input.timeCost) ?? 0) : null,
    snapshot: show ? input.snapshot : null,
    actual: show ? fixed2(actual) : null,
    variance: show && variance !== null ? fixed2(variance) : null,
    variancePercent,
    overBudget: variance !== null && variance > 0,
    baseline: input.baseline
      ? { version: input.baseline.version, goLive: input.baseline.goLive ? input.baseline.goLive.toISOString() : null }
      : null,
  };
}
