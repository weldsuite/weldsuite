/**
 * The Summary and Insights tabs: per-field aggregates of the completed
 * responses, and views, starts, completions, time and drop-off.
 *
 * Aggregates are worked out in memory over at most `FORM_LIMITS.maxExportRows`
 * answers: the shapes (choices by id, ranking positions, matrix cells) are
 * easier to keep exact in code than in SQL, and the same code runs in the Rust
 * twin's tests.
 */

import { and, eq, sql } from 'drizzle-orm';
import { schema } from '@weldsuite/worker-kit/db';
import {
  displayAnswer,
  isAnswered,
  isBooleanField,
  isChoiceField,
  isFileField,
  isNumericField,
  type ChoiceField,
  type FieldBlock,
  type FieldBlockOf,
  type FileField,
} from '@weldsuite/forms-engine';
import type { Block } from '@weldsuite/forms-engine/definition';
import {
  FORM_LIMITS,
  type FormFieldSummary,
  type FormInsights,
  type FormResultsSummary,
  type FormSummaryQuery,
} from '@weldsuite/app-api-client/schemas/weldforms';
import type { FormCountersPort } from '../lib/counters';
import type { WorkspaceCtx } from './context';
import { loadVersions, responseConditions, type VersionInfo } from './response-model';

const { formResponses } = schema;

const LATEST = 20;
const MAX_DISTINCT = 60;

const round1 = (n: number) => Math.round(n * 10) / 10;
const percentOf = (count: number, total: number) => (total === 0 ? 0 : round1((count / total) * 100));

interface Answered {
  responseId: string;
  value: unknown;
  at: Date;
}

/** What every field summary starts with. */
type SummaryBase = { blockId: string; type: FieldBlock['type']; title: string; answered: number };

const newestFirst = (a: Answered, b: Answered) => b.at.getTime() - a.at.getTime();

function npsSummary(base: SummaryBase, answered: readonly Answered[]): FormFieldSummary {
  const n = answered.length;
  const counts = new Map<number, number>();
  for (const r of answered) counts.set(r.value as number, (counts.get(r.value as number) ?? 0) + 1);
  const promoters = answered.filter((r) => (r.value as number) >= 9).length;
  const detractors = answered.filter((r) => (r.value as number) <= 6).length;
  return {
    kind: 'nps',
    ...base,
    score: n === 0 ? null : Math.round(((promoters - detractors) / n) * 100),
    promoters,
    passives: n - promoters - detractors,
    detractors,
    distribution: Array.from({ length: 11 }, (_, value) => ({ value, count: counts.get(value) ?? 0 })),
  };
}

function numericSummary(base: SummaryBase, answered: readonly Answered[]): FormFieldSummary {
  const n = answered.length;
  const values = answered.map((r) => r.value as number);
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  const distribution = [...counts].sort((a, b) => a[0] - b[0]).map(([value, count]) => ({ value, count }));
  return {
    kind: 'numeric',
    ...base,
    average: n === 0 ? null : Math.round((values.reduce((a, b) => a + b, 0) / n) * 100) / 100,
    min: n === 0 ? null : Math.min(...values),
    max: n === 0 ? null : Math.max(...values),
    distribution: distribution.length <= MAX_DISTINCT ? distribution : [],
  };
}

function choiceSummary(field: ChoiceField, base: SummaryBase, answered: readonly Answered[]): FormFieldSummary {
  const n = answered.length;
  const counts = new Map<string, number>();
  const others: Answered[] = [];
  for (const r of answered) {
    const a = r.value as { choiceIds: string[]; other?: string };
    for (const id of a.choiceIds) counts.set(id, (counts.get(id) ?? 0) + 1);
    if (a.other !== undefined) others.push({ ...r, value: a.other });
  }
  return {
    kind: 'choice',
    ...base,
    choices: field.properties.choices.map((c) => ({ id: c.id, label: c.label, count: counts.get(c.id) ?? 0, percent: percentOf(counts.get(c.id) ?? 0, n) })),
    other: others.length,
    otherLatest: others
      .sort(newestFirst)
      .slice(0, LATEST)
      .map((r) => ({ responseId: r.responseId, value: String(r.value), submittedAt: r.at.toISOString() })),
  };
}

function rankingSummary(field: FieldBlockOf<'ranking'>, base: SummaryBase, answered: readonly Answered[]): FormFieldSummary {
  const sums = new Map<string, { total: number; count: number }>();
  for (const r of answered) {
    (r.value as string[]).forEach((id, index) => {
      const s = sums.get(id) ?? { total: 0, count: 0 };
      sums.set(id, { total: s.total + index + 1, count: s.count + 1 });
    });
  }
  return {
    kind: 'ranking',
    ...base,
    choices: field.properties.choices.map((c) => {
      const s = sums.get(c.id);
      return { id: c.id, label: c.label, averageRank: s ? Math.round((s.total / s.count) * 100) / 100 : null };
    }),
  };
}

function matrixSummary(field: FieldBlockOf<'matrix'>, base: SummaryBase, answered: readonly Answered[]): FormFieldSummary {
  const cells = new Map<string, Record<string, number>>();
  for (const r of answered) {
    for (const [rowId, columnIds] of Object.entries(r.value as Record<string, string[]>)) {
      const row = cells.get(rowId) ?? {};
      for (const columnId of columnIds) row[columnId] = (row[columnId] ?? 0) + 1;
      cells.set(rowId, row);
    }
  }
  return {
    kind: 'matrix',
    ...base,
    columns: field.properties.columns.map((c) => ({ id: c.id, label: c.label })),
    rows: field.properties.rows.map((row) => ({ id: row.id, label: row.label, counts: cells.get(row.id) ?? {} })),
  };
}

function filesSummary(field: FileField, base: SummaryBase, answered: readonly Answered[]): FormFieldSummary {
  const files = answered.reduce((sum, r) => sum + (field.type === 'signature' ? 1 : (r.value as unknown[]).length), 0);
  return { kind: 'files', ...base, files };
}

/** Text, dates, contact info, address: the newest answers as text. */
function textSummary(field: FieldBlock, base: SummaryBase, answered: readonly Answered[]): FormFieldSummary {
  const newest = [...answered].sort(newestFirst);
  return {
    kind: 'text',
    ...base,
    latest: newest.slice(0, LATEST).map((r) => ({ responseId: r.responseId, value: displayAnswer(field, r.value), submittedAt: r.at.toISOString() })),
  };
}

function summariseField(field: FieldBlock, rows: Answered[]): FormFieldSummary {
  const answered = rows.filter((r) => isAnswered(field, r.value));
  const base: SummaryBase = { blockId: field.id, type: field.type, title: field.title || field.ref, answered: answered.length };

  if (field.type === 'nps') return npsSummary(base, answered);
  if (isNumericField(field)) return numericSummary(base, answered);
  if (isBooleanField(field)) {
    const yes = answered.filter((r) => r.value === true).length;
    return { kind: 'boolean', ...base, yes, no: answered.length - yes };
  }
  if (isChoiceField(field)) return choiceSummary(field, base, answered);
  if (field.type === 'ranking') return rankingSummary(field, base, answered);
  if (field.type === 'matrix') return matrixSummary(field, base, answered);
  if (isFileField(field)) return filesSummary(field, base, answered);
  return textSummary(field, base, answered);
}

/** Per field of the form (every version, the newest definition of each), over the completed responses. */
export async function summarise(ctx: Pick<WorkspaceCtx, 'db'>, formId: string, query: FormSummaryQuery): Promise<FormResultsSummary> {
  const versions = await loadVersions(ctx.db, formId);
  const scope = query.versionId ? versions.filter((v) => v.id === query.versionId) : versions;
  const fields = new Map<string, FieldBlock>();
  for (const v of scope) for (const [id, field] of v.fields) fields.set(id, field);

  const where = responseConditions(formId, { status: 'completed', from: query.from, to: query.to, versionId: query.versionId }, fields);
  const rows = await ctx.db
    .select({ id: formResponses.id, answers: formResponses.answers, submittedAt: formResponses.submittedAt, startedAt: formResponses.startedAt, score: formResponses.score })
    .from(formResponses)
    .where(where)
    .orderBy(sql`${formResponses.submittedAt} desc`)
    .limit(FORM_LIMITS.maxExportRows);

  const scores = rows.map((r) => r.score).filter((s): s is number => s !== null);
  const summaries: FormFieldSummary[] = [];
  for (const field of fields.values()) {
    const answered: Answered[] = [];
    for (const row of rows) {
      const value = (row.answers ?? {})[field.id];
      if (value !== undefined) answered.push({ responseId: row.id, value, at: row.submittedAt ?? row.startedAt });
    }
    summaries.push(summariseField(field, answered));
  }
  return {
    totalResponses: rows.length,
    averageScore: scores.length === 0 ? null : Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 100) / 100,
    fields: summaries,
  };
}

// ---------------------------------------------------------------------------
// Insights
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;
const dayOf = (d: Date) => d.toISOString().slice(0, 10);

/** The top-level blocks a respondent can leave on: fields and groups. */
function stops(version: VersionInfo): Array<{ id: string; title: string }> {
  return version.definition.blocks
    .filter((b: Block) => b.type !== 'page_break' && b.type !== 'statement')
    .map((b) => ({ id: b.id, title: ('title' in b && typeof b.title === 'string' && b.title) || ('ref' in b && typeof b.ref === 'string' ? b.ref : b.id) }));
}

interface InsightRow {
  status: string;
  startedAt: Date;
  submittedAt: Date | null;
  lastBlockId: string | null;
  source: string | null;
}

type DayCounts = { views: number; starts: number; completions: number };

/** Views, starts and completions per UTC day, every day of the range included. */
function countByDay(range: { from: Date; to: Date }, views: Record<string, number>, rows: readonly InsightRow[], completed: readonly InsightRow[]): Map<string, DayCounts> {
  const { from, to } = range;
  const days = new Map<string, DayCounts>();
  const bump = (day: string, key: keyof DayCounts, by: number) => {
    const d = days.get(day) ?? { views: 0, starts: 0, completions: 0 };
    d[key] += by;
    days.set(day, d);
  };
  for (let t = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()); t <= to.getTime(); t += DAY_MS) days.set(dayOf(new Date(t)), { views: 0, starts: 0, completions: 0 });
  for (const [day, count] of Object.entries(views)) bump(day, 'views', count);
  for (const r of rows) bump(dayOf(r.startedAt), 'starts', 1);
  for (const r of completed) if (r.submittedAt) bump(dayOf(r.submittedAt), 'completions', 1);
  return days;
}

/** Starts and completions per source (`link` when the response has none). */
function countBySource(rows: readonly InsightRow[]): Map<string, { starts: number; completions: number }> {
  const bySource = new Map<string, { starts: number; completions: number }>();
  for (const r of rows) {
    const key = r.source || 'link';
    const s = bySource.get(key) ?? { starts: 0, completions: 0 };
    s.starts += 1;
    if (r.status === 'completed') s.completions += 1;
    bySource.set(key, s);
  }
  return bySource;
}

/** How many reached each block and how many left there; completed responses reached every block. */
function dropOffOf(blocks: ReadonlyArray<{ id: string; title: string }>, rows: readonly InsightRow[], completedCount: number): FormInsights['dropOff'] {
  const leftAt = new Map<string, number>();
  for (const r of rows) if (r.status === 'in_progress' && r.lastBlockId) leftAt.set(r.lastBlockId, (leftAt.get(r.lastBlockId) ?? 0) + 1);
  return blocks.map((block, index) => {
    const beyond = blocks.slice(index).reduce((sum, b) => sum + (leftAt.get(b.id) ?? 0), 0);
    const reached = completedCount + beyond;
    const leftHere = leftAt.get(block.id) ?? 0;
    return { blockId: block.id, title: block.title, reached, leftHere, dropOffRate: reached === 0 ? 0 : Math.round((leftHere / reached) * 1000) / 1000 };
  });
}

/**
 * Views per day come from the form's counters; everything else from the
 * responses started in the range. `completions` and `completionRate` count
 * the started responses that were completed, so the rate stays within 0..1.
 * A response's drop-off point is its `last_block_id`; completed responses
 * count as having reached every block.
 */
export async function insights(
  ctx: Pick<WorkspaceCtx, 'db'>,
  formId: string,
  counters: FormCountersPort,
  range: { from?: string; to?: string },
  now = new Date(),
): Promise<FormInsights> {
  const to = range.to ? new Date(range.to) : now;
  const from = range.from ? new Date(range.from) : new Date(to.getTime() - 29 * DAY_MS);
  const versions = await loadVersions(ctx.db, formId);
  const latest = versions[versions.length - 1];

  const rows = await ctx.db
    .select({
      status: formResponses.status,
      startedAt: formResponses.startedAt,
      submittedAt: formResponses.submittedAt,
      durationMs: formResponses.durationMs,
      lastBlockId: formResponses.lastBlockId,
      source: sql<string | null>`${formResponses.metadata} ->> 'source'`,
    })
    .from(formResponses)
    .where(and(eq(formResponses.formId, formId), sql`${formResponses.startedAt} >= ${from.toISOString()}::timestamptz`, sql`${formResponses.startedAt} <= ${to.toISOString()}::timestamptz`));

  const views = await counters.viewsByDay(dayOf(from), dayOf(to));
  const completed = rows.filter((r) => r.status === 'completed');
  const days = countByDay({ from, to }, views, rows, completed);
  const durations = completed.map((r) => r.durationMs).filter((d): d is number => d !== null);
  const bySource = countBySource(rows);
  const dropOff = dropOffOf(latest ? stops(latest) : [], rows, completed.length);

  return {
    views: Object.values(views).reduce((a, b) => a + b, 0),
    starts: rows.length,
    completions: completed.length,
    completionRate: rows.length === 0 ? null : Math.round((completed.length / rows.length) * 1000) / 1000,
    averageDurationMs: durations.length === 0 ? null : Math.round(durations.reduce((a, b) => a + b, 0) / durations.length),
    byDay: [...days].sort((a, b) => a[0].localeCompare(b[0])).map(([date, d]) => ({ date, ...d })),
    dropOff,
    bySource: [...bySource].sort((a, b) => b[1].starts - a[1].starts).map(([source, s]) => ({ source, ...s })),
  };
}
