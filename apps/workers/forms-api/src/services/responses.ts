/**
 * Responses as members see them: the list (filters, search, sort), one
 * response with its actions, deleting (one, many, a respondent's everything),
 * file downloads, a person's responses across forms and the retry of an
 * integration step. Pure functions over a `WorkspaceCtx`.
 */

import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { atomically } from '@weldsuite/worker-kit/atomically';
import { schema } from '@weldsuite/worker-kit/db';
import type {
  FormResponseDetail,
  FormResponseDto,
  FormResponseAction,
  FormUserRef,
  ListFormResponsesQuery,
} from '@weldsuite/app-api-client/schemas/weldforms';
import { FormsError, notFound } from '../lib/errors';
import { startProcessing } from './process';
import type { WorkspaceCtx } from './context';
import type { FormRow } from './forms';
import { memberRefs } from './members';
import {
  latestFields,
  loadVersions,
  responseConditions,
  responseOrder,
  toResponseDto,
  type FileRow,
  type ResponseRow,
  type VersionInfo,
} from './response-model';

const { forms, formResponses, formResponseFiles, formResponseActions, formIntegrations } = schema;

const DEFAULT_LIMIT = 50;

/** Files of the given responses, grouped by response id. */
async function filesOf(ctx: Pick<WorkspaceCtx, 'db'>, responseIds: string[]): Promise<Map<string, FileRow[]>> {
  const byResponse = new Map<string, FileRow[]>();
  if (responseIds.length === 0) return byResponse;
  const files = await ctx.db.select().from(formResponseFiles).where(inArray(formResponseFiles.responseId, responseIds)).orderBy(formResponseFiles.createdAt);
  for (const file of files) byResponse.set(file.responseId, [...(byResponse.get(file.responseId) ?? []), file]);
  return byResponse;
}

async function dtos(ctx: Pick<WorkspaceCtx, 'db'>, rows: ResponseRow[], versionNumbers: Map<string, number>): Promise<FormResponseDto[]> {
  const [files, refs] = await Promise.all([
    filesOf(ctx, rows.map((r) => r.id)),
    memberRefs(ctx.db, rows.map((r) => r.respondentUserId).filter((id): id is string => Boolean(id))),
  ]);
  const now = Date.now();
  return rows.map((row) =>
    toResponseDto(row, {
      versionNumber: versionNumbers.get(row.versionId) ?? 0,
      files: files.get(row.id) ?? [],
      respondent: row.respondentUserId ? (refs.get(row.respondentUserId) as FormUserRef) : null,
      now,
    }),
  );
}

export interface ResponsePage {
  rows: FormResponseDto[];
  total: number;
  next: string | null;
}

export async function listResponses(ctx: Pick<WorkspaceCtx, 'db'>, formId: string, query: ListFormResponsesQuery): Promise<ResponsePage> {
  const versions = await loadVersions(ctx.db, formId);
  const where = responseConditions(formId, query, latestFields(versions));
  const limit = query.limit ?? DEFAULT_LIMIT;
  const offset = query.cursor ? Math.max(0, Number(query.cursor) || 0) : 0;
  const [rows, [count]] = await Promise.all([
    ctx.db.select().from(formResponses).where(where).orderBy(...responseOrder(query.sort)).limit(limit).offset(offset),
    ctx.db.select({ n: sql<number>`count(*)::int` }).from(formResponses).where(where),
  ]);
  const total = Number(count?.n ?? 0);
  const next = offset + rows.length;
  return {
    rows: await dtos(ctx, rows, new Map(versions.map((v) => [v.id, v.number]))),
    total,
    next: next < total ? String(next) : null,
  };
}

export async function getResponse(ctx: Pick<WorkspaceCtx, 'db'>, formId: string, responseId: string): Promise<FormResponseDetail> {
  const [row] = await ctx.db.select().from(formResponses).where(and(eq(formResponses.id, responseId), eq(formResponses.formId, formId))).limit(1);
  if (!row) throw notFound('Response');
  const versions = await loadVersions(ctx.db, formId);
  const [[dto], actions] = await Promise.all([
    dtos(ctx, [row], new Map(versions.map((v) => [v.id, v.number]))),
    ctx.db.select().from(formResponseActions).where(eq(formResponseActions.responseId, row.id)).orderBy(formResponseActions.createdAt),
  ]);
  return {
    ...dto!,
    actions: actions.map(
      (a): FormResponseAction => ({
        id: a.id,
        integrationId: a.integrationId,
        kind: a.kind,
        status: a.status,
        entityType: a.entityType,
        entityId: a.entityId,
        error: a.error,
        attempts: a.attempts,
        updatedAt: a.updatedAt.toISOString(),
      }),
    ),
  };
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

export interface DeletedResponse {
  id: string;
  formId: string;
  formTitle: string;
  number: number | null;
  respondentEmail: string | null;
  personId: string | null;
  invitationId: string | null;
}

/**
 * Deletes responses with their files and action rows; completed ones lower the
 * form's `response_count`. Returns what went (for the events) and the bucket
 * keys the caller removes after answering.
 */
export async function deleteResponses(
  ctx: Pick<WorkspaceCtx, 'db'>,
  responseIds: string[],
  scope: { formId?: string } = {},
): Promise<{ deleted: DeletedResponse[]; keys: string[] }> {
  if (responseIds.length === 0) return { deleted: [], keys: [] };
  const where = scope.formId
    ? and(inArray(formResponses.id, responseIds), eq(formResponses.formId, scope.formId))
    : inArray(formResponses.id, responseIds);
  const rows = await ctx.db.select().from(formResponses).where(where);
  if (rows.length === 0) return { deleted: [], keys: [] };
  const ids = rows.map((r) => r.id);
  const files = await ctx.db.select({ key: formResponseFiles.storageKey }).from(formResponseFiles).where(inArray(formResponseFiles.responseId, ids));
  const titles = new Map((await ctx.db.select({ id: forms.id, title: forms.title }).from(forms).where(inArray(forms.id, [...new Set(rows.map((r) => r.formId))]))).map((f) => [f.id, f.title]));
  const completedByForm = new Map<string, number>();
  for (const r of rows) if (r.status === 'completed') completedByForm.set(r.formId, (completedByForm.get(r.formId) ?? 0) + 1);

  await atomically(ctx.db, (db) => [
    db.delete(formResponseActions).where(inArray(formResponseActions.responseId, ids)),
    db.delete(formResponseFiles).where(inArray(formResponseFiles.responseId, ids)),
    db.delete(formResponses).where(inArray(formResponses.id, ids)),
    ...[...completedByForm].map(([formId, n]) => db.update(forms).set({ responseCount: sql`greatest(${forms.responseCount} - ${n}, 0)` }).where(eq(forms.id, formId))),
  ]);
  return {
    deleted: rows.map((r) => ({
      id: r.id,
      formId: r.formId,
      formTitle: titles.get(r.formId) ?? '',
      number: r.number,
      respondentEmail: r.respondentEmail,
      personId: r.personId,
      invitationId: r.invitationId,
    })),
    keys: files.map((f) => f.key),
  };
}

/** The ids of every response whose respondent email matches on the given forms, for the GDPR erase. */
export async function responseIdsByEmail(ctx: Pick<WorkspaceCtx, 'db'>, email: string, formIds: string[]): Promise<string[]> {
  if (formIds.length === 0) return [];
  const rows = await ctx.db
    .select({ id: formResponses.id })
    .from(formResponses)
    .where(and(inArray(formResponses.formId, formIds), sql`lower(${formResponses.respondentEmail}) = ${email.trim().toLowerCase()}`));
  return rows.map((r) => r.id);
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

export async function findResponseFile(ctx: Pick<WorkspaceCtx, 'db'>, formId: string, responseId: string, fileId: string): Promise<FileRow> {
  const [file] = await ctx.db
    .select()
    .from(formResponseFiles)
    .where(and(eq(formResponseFiles.id, fileId), eq(formResponseFiles.responseId, responseId), eq(formResponseFiles.formId, formId)))
    .limit(1);
  if (!file) throw notFound('File');
  return file;
}

// ---------------------------------------------------------------------------
// A person's responses across forms
// ---------------------------------------------------------------------------

/** Responses linked to a CRM person, newest first, only on `formIds` (the forms the member may see). */
export async function listPersonResponses(
  ctx: Pick<WorkspaceCtx, 'db'>,
  personId: string,
  formIds: string[],
  paging: { cursor?: string; limit?: number },
): Promise<ResponsePage> {
  if (formIds.length === 0) return { rows: [], total: 0, next: null };
  const where: SQL = and(eq(formResponses.personId, personId), inArray(formResponses.formId, formIds))!;
  const limit = paging.limit ?? DEFAULT_LIMIT;
  const offset = paging.cursor ? Math.max(0, Number(paging.cursor) || 0) : 0;
  const [rows, [count]] = await Promise.all([
    ctx.db
      .select()
      .from(formResponses)
      .where(where)
      .orderBy(sql`coalesce(${formResponses.submittedAt}, ${formResponses.startedAt}) desc`, desc(formResponses.id))
      .limit(limit)
      .offset(offset),
    ctx.db.select({ n: sql<number>`count(*)::int` }).from(formResponses).where(where),
  ]);
  const versionIds = [...new Set(rows.map((r) => r.versionId))];
  const numbers = new Map<string, number>();
  if (versionIds.length > 0) {
    for (const v of await ctx.db.select({ id: schema.formVersions.id, number: schema.formVersions.number }).from(schema.formVersions).where(inArray(schema.formVersions.id, versionIds))) numbers.set(v.id, v.number);
  }
  const total = Number(count?.n ?? 0);
  const next = offset + rows.length;
  return { rows: await dtos(ctx, rows, numbers), total, next: next < total ? String(next) : null };
}

// ---------------------------------------------------------------------------
// Retry an integration step
// ---------------------------------------------------------------------------

/**
 * Runs one integration's step again for a response: a ProcessResponse run
 * restricted to that integration (`retryIntegrationId`), under an instance id of
 * its own. 409 for a response that is not completed, 404 when the action or
 * its integration is gone.
 */
export async function retryAction(ctx: WorkspaceCtx, form: FormRow, responseId: string, actionId: string, waitUntil: (p: Promise<unknown>) => void): Promise<void> {
  const [action] = await ctx.db
    .select()
    .from(formResponseActions)
    .where(and(eq(formResponseActions.id, actionId), eq(formResponseActions.responseId, responseId), eq(formResponseActions.formId, form.id)))
    .limit(1);
  if (!action) throw notFound('Action');
  const [response] = await ctx.db.select({ status: formResponses.status }).from(formResponses).where(and(eq(formResponses.id, responseId), eq(formResponses.formId, form.id))).limit(1);
  if (!response) throw notFound('Response');
  if (response.status !== 'completed') throw new FormsError(409, 'NOT_COMPLETED', 'Only a completed response can be processed again.');
  const [integration] = await ctx.db.select({ id: formIntegrations.id }).from(formIntegrations).where(eq(formIntegrations.id, action.integrationId)).limit(1);
  if (!integration) throw notFound('Integration');
  await ctx.db.update(formResponseActions).set({ status: 'pending', error: null, updatedAt: new Date() }).where(eq(formResponseActions.id, action.id));
  await startProcessing(
    ctx.env,
    { clerkOrgId: ctx.clerkOrgId, workspaceId: ctx.workspaceId, formId: form.id, responseId, mode: 'submit', retryIntegrationId: integration.id },
    waitUntil,
  );
}

export type { VersionInfo };
