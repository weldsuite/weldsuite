/**
 * AI summaries of a form's open-text answers, cached in `form_ai_summaries`
 * (per question, or `blockId` null for the whole form) with the number of
 * completed responses they were made from; a different count is `stale`.
 * Regenerating is on demand (POST), never automatic.
 *
 * Only free-text questions the author did not mark sensitive are read: a
 * sensitive answer is not sent to a model any more than it is put on the
 * entity-event bus (ADR FORMS-004). Input is capped (services/ai.ts).
 */

import { and, count, desc, eq, isNull } from 'drizzle-orm';
import { schema } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { displayAnswer, fieldsOf, ownValue } from '@weldsuite/forms-engine';
import { formDefinitionSchema, type FieldBlock, type FormDefinition } from '@weldsuite/forms-engine/definition';
import type { AiSummaryContent, FormAiSummary } from '@weldsuite/app-api-client/schemas/weldforms';
import type { AiMetering } from '@weldsuite/core-domain/ai-billing';
import { FormsError } from '../lib/errors';
import { summariseAnswers, type AnswerSet } from './ai';
import type { WorkspaceCtx } from './context';

const { formAiSummaries, formResponses, formVersions } = schema;

/** The newest completed responses one summary reads. */
const MAX_RESPONSES = 500;
const OPEN_TEXT: ReadonlySet<string> = new Set(['short_text', 'long_text']);

const isOpenText = (field: FieldBlock) => OPEN_TEXT.has(field.type) && !field.sensitive;

async function completedCount(ctx: WorkspaceCtx, formId: string): Promise<number> {
  const [row] = await ctx.db
    .select({ n: count() })
    .from(formResponses)
    .where(and(eq(formResponses.formId, formId), eq(formResponses.status, 'completed')));
  return row?.n ?? 0;
}

/** The latest cached summary of a question (`blockId`) or of the whole form (null), and whether it is stale. */
export async function getAiSummary(ctx: WorkspaceCtx, formId: string, blockId: string | null): Promise<FormAiSummary> {
  const [row] = await ctx.db
    .select()
    .from(formAiSummaries)
    .where(and(eq(formAiSummaries.formId, formId), blockId === null ? isNull(formAiSummaries.blockId) : eq(formAiSummaries.blockId, blockId)))
    .orderBy(desc(formAiSummaries.createdAt))
    .limit(1);
  if (!row) return { blockId, summary: null, stale: false, responseCount: 0, createdAt: null };
  const now = await completedCount(ctx, formId);
  return { blockId, summary: row.summary as unknown as AiSummaryContent, stale: row.responseCount !== now, responseCount: row.responseCount, createdAt: row.createdAt.toISOString() };
}

/** The definitions of every version of the form that still parses, by version id, newest first. */
async function loadDefinitions(ctx: WorkspaceCtx, formId: string): Promise<Map<string, FormDefinition>> {
  const versions = await ctx.db.select({ id: formVersions.id, definition: formVersions.definition }).from(formVersions).where(eq(formVersions.formId, formId)).orderBy(desc(formVersions.number));
  const definitions = new Map<string, FormDefinition>();
  for (const v of versions) {
    const parsed = formDefinitionSchema.safeParse(v.definition);
    if (parsed.success) definitions.set(v.id, parsed.data);
  }
  return definitions;
}

/** The question must be open text, not sensitive, in some version: else there is nothing to summarise. */
function assertSummarisable(definitions: readonly FormDefinition[], blockId: string): void {
  const known = definitions.flatMap((d) => fieldsOf(d)).find((f) => f.id === blockId);
  if (!known) throw new FormsError(404, 'NOT_FOUND', 'Question not found');
  if (!isOpenText(known) || definitions.some((d) => fieldsOf(d).some((f) => f.id === blockId && f.sensitive))) {
    throw new FormsError(422, 'NOT_SUMMARISABLE', 'Only open text questions that are not marked sensitive can be summarised.');
  }
}

/** Titles come from the latest version that still has the question. */
function latestTitles(definitions: readonly FormDefinition[]): Map<string, string> {
  const titles = new Map<string, string>();
  for (const d of definitions) for (const f of fieldsOf(d)) if (!titles.has(f.id)) titles.set(f.id, f.title);
  return titles;
}

interface AnswerRow {
  versionId: string;
  answers: Parameters<typeof ownValue>[0];
}

/** The answers of the rows grouped per question, for the fields `wanted` keeps. */
function groupAnswers(
  rows: readonly AnswerRow[],
  definitions: ReadonlyMap<string, FormDefinition>,
  titles: ReadonlyMap<string, string>,
  wanted: (field: FieldBlock) => boolean,
): AnswerSet[] {
  const sets = new Map<string, AnswerSet>();
  for (const row of rows) {
    const definition = definitions.get(row.versionId);
    if (!definition) continue;
    for (const field of fieldsOf(definition).filter(wanted)) {
      const text = displayAnswer(field, ownValue(row.answers, field.id)).trim();
      if (!text) continue;
      const set = sets.get(field.id) ?? { blockId: field.id, title: titles.get(field.id) ?? field.title, answers: [] };
      set.answers.push(text);
      sets.set(field.id, set);
    }
  }
  return [...sets.values()];
}

/** The answers of the open-text questions (one, or all) across versions, newest responses first. */
async function collectAnswers(ctx: WorkspaceCtx, formId: string, blockId: string | null): Promise<{ sets: AnswerSet[]; language: string; title: string | null }> {
  const definitions = await loadDefinitions(ctx, formId);
  const all = [...definitions.values()];
  const latest = all[0];

  if (blockId !== null) assertSummarisable(all, blockId);

  const rows = await ctx.db
    .select({ versionId: formResponses.versionId, answers: formResponses.answers })
    .from(formResponses)
    .where(and(eq(formResponses.formId, formId), eq(formResponses.status, 'completed')))
    .orderBy(desc(formResponses.submittedAt))
    .limit(MAX_RESPONSES);

  const titles = latestTitles(all);
  const sensitive = new Set(all.flatMap((d) => fieldsOf(d).filter((f) => f.sensitive).map((f) => f.id)));
  const wanted = (field: FieldBlock) => isOpenText(field) && !sensitive.has(field.id) && (blockId === null || field.id === blockId);
  const sets = groupAnswers(rows, definitions, titles, wanted);
  return { sets, language: latest?.presentation.language ?? 'en', title: blockId === null ? null : (titles.get(blockId) ?? null) };
}

/** Makes a new summary (replacing the cached one), charges it and stores it. */
export async function createAiSummary(
  ctx: WorkspaceCtx,
  formId: string,
  blockId: string | null,
  userId: string,
  metering: AiMetering | null,
): Promise<FormAiSummary> {
  const { sets, language, title } = await collectAnswers(ctx, formId, blockId);
  if (sets.length === 0) throw new FormsError(422, 'NOTHING_TO_SUMMARISE', 'There are no open text answers to summarise yet.');
  const responseCount = await completedCount(ctx, formId);
  const summary = await summariseAnswers(ctx.env, sets, { title, language }, metering);
  const [row] = await ctx.db
    .insert(formAiSummaries)
    .values({ id: generateId('fas'), formId, blockId, responseCount, summary: summary as unknown as Record<string, unknown>, createdByUserId: userId })
    .returning();
  // One cached summary per question: older ones are of no use any more.
  const older = await ctx.db
    .select({ id: formAiSummaries.id })
    .from(formAiSummaries)
    .where(and(eq(formAiSummaries.formId, formId), blockId === null ? isNull(formAiSummaries.blockId) : eq(formAiSummaries.blockId, blockId)));
  for (const o of older) if (o.id !== row!.id) await ctx.db.delete(formAiSummaries).where(eq(formAiSummaries.id, o.id));
  return { blockId, summary, stale: false, responseCount, createdAt: row!.createdAt.toISOString() };
}
