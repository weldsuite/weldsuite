/**
 * Versions and the lifecycle: publish (snapshot a version, allocate the public
 * link on the first publish, write the public cache, screen the content),
 * close, reopen and discard the draft's changes.
 *
 * A response points at the version it answered, so editing a live form changes
 * the draft only; "Publish changes" makes the next version (ADR FORMS-003).
 */

import { desc, eq, max, sql } from 'drizzle-orm';
import { atomically } from '@weldsuite/worker-kit/atomically';
import { masterSchema, schema } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { ALPHANUMERIC, randomString } from '@weldsuite/worker-kit/random';
import { fieldsOf, parseDefinition } from '@weldsuite/forms-engine';
import { formDefinitionSchema, formThemeTokensSchema } from '@weldsuite/forms-engine/definition';
import type { FormVersionDetail, FormVersionSummary } from '@weldsuite/app-api-client/schemas/weldforms';
import { FormsError, notFound } from '../lib/errors';
import type { WorkspaceCtx } from './context';
import { screenForm } from './content-screen';
import type { FormRow } from './forms';
import { memberRefs } from './members';
import { refreshPublicCache } from './public-cache';

const { forms, formVersions, formThemes, formResponses } = schema;
const { formLinkRegistry } = masterSchema;

/** The theme a new version is published with: the form's own, else the workspace default, else the defaults. */
async function themeSnapshot(ctx: Pick<WorkspaceCtx, 'db'>, form: FormRow): Promise<Record<string, unknown>> {
  const [chosen] = form.themeId ? await ctx.db.select().from(formThemes).where(eq(formThemes.id, form.themeId)).limit(1) : [];
  const [fallback] = chosen ? [] : await ctx.db.select().from(formThemes).where(eq(formThemes.isDefault, true)).limit(1);
  return formThemeTokensSchema.parse((chosen ?? fallback)?.tokens ?? {});
}

/** A fresh 10-character base62 id, registered in the master registry; retried on the rare collision. */
async function allocateLink(ctx: WorkspaceCtx, formId: string): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const publicId = randomString(10, ALPHANUMERIC);
    const inserted = await ctx.master
      .insert(formLinkRegistry)
      .values({ id: generateId('fln'), publicId, workspaceId: ctx.workspaceId, clerkOrgId: ctx.clerkOrgId, formId })
      .onConflictDoNothing({ target: formLinkRegistry.publicId })
      .returning({ id: formLinkRegistry.id });
    if (inserted.length > 0) return publicId;
  }
  throw new FormsError(503, 'LINK_ALLOCATION_FAILED', 'Could not allocate a public link. Try again.');
}

export interface PublishOutcome {
  form: FormRow;
  version: { id: string; number: number };
}

/**
 * Publishes the draft as the next version. 422 `INVALID_DEFINITION` (details:
 * the engine's issues) when the definition breaks a rule the schema cannot
 * express, 422 `NO_QUESTIONS` when it has no field at all.
 */
export async function publishForm(ctx: WorkspaceCtx, form: FormRow, userId: string): Promise<PublishOutcome> {
  const parsed = parseDefinition(form.definition);
  if (!parsed.ok) throw new FormsError(422, 'INVALID_DEFINITION', 'The form has problems that must be fixed before it can be published.', { issues: parsed.issues });
  const definition = parsed.definition;
  if (fieldsOf(definition).length === 0) throw new FormsError(422, 'NO_QUESTIONS', 'Add at least one question before publishing.');

  const publicId = form.publicId ?? (await allocateLink(ctx, form.id));
  const [latest] = await ctx.db.select({ n: max(formVersions.number) }).from(formVersions).where(eq(formVersions.formId, form.id));
  const number = (latest?.n ?? 0) + 1;
  const versionId = generateId('fve');
  const now = new Date();

  const theme = await themeSnapshot(ctx, form);
  await atomically(ctx.db, (db) => [
    db.insert(formVersions).values({ id: versionId, formId: form.id, number, definition, theme, publishedByUserId: userId, publishedAt: now }),
    db
      .update(forms)
      .set({
        status: 'published',
        publicId,
        publishedVersionId: versionId,
        publishedAt: now,
        closedAt: null,
        hasUnpublishedChanges: false,
        updatedAt: now,
      })
      .where(eq(forms.id, form.id)),
  ]);
  const [row] = await ctx.db.select().from(forms).where(eq(forms.id, form.id)).limit(1);
  if (!row) throw notFound('Form');

  // The content screen holds a suspicious form for staff; it never un-holds one (only staff do).
  const heldReason = screenForm(row.title, definition);
  if (heldReason) {
    await ctx.master.update(formLinkRegistry).set({ heldAt: now, heldReason }).where(eq(formLinkRegistry.publicId, publicId));
  }
  await refreshPublicCache(ctx, row);
  return { form: row, version: { id: versionId, number } };
}

/** Stops taking responses by hand. 409 `NOT_PUBLISHED` for a form that is not live. */
export async function closeForm(ctx: WorkspaceCtx, form: FormRow): Promise<FormRow> {
  if (form.status !== 'published') throw new FormsError(409, 'NOT_PUBLISHED', 'Only a published form can be closed.');
  const [row] = await ctx.db.update(forms).set({ status: 'closed', closedAt: new Date(), updatedAt: new Date() }).where(eq(forms.id, form.id)).returning();
  if (!row) throw notFound('Form');
  await refreshPublicCache(ctx, row);
  return row;
}

export async function reopenForm(ctx: WorkspaceCtx, form: FormRow): Promise<FormRow> {
  if (form.status !== 'closed' || !form.publishedVersionId) throw new FormsError(409, 'NOT_CLOSED', 'Only a closed form can be reopened.');
  const [row] = await ctx.db.update(forms).set({ status: 'published', closedAt: null, updatedAt: new Date() }).where(eq(forms.id, form.id)).returning();
  if (!row) throw notFound('Form');
  await refreshPublicCache(ctx, row);
  return row;
}

/** Throws the draft away and goes back to the published version. */
export async function discardChanges(ctx: WorkspaceCtx, form: FormRow): Promise<FormRow> {
  if (!form.publishedVersionId) throw new FormsError(409, 'NOT_PUBLISHED', 'This form has no published version to go back to.');
  const [version] = await ctx.db.select().from(formVersions).where(eq(formVersions.id, form.publishedVersionId)).limit(1);
  if (!version) throw notFound('Version');
  const [row] = await ctx.db
    .update(forms)
    .set({ definition: formDefinitionSchema.parse(version.definition), hasUnpublishedChanges: false, revision: sql`${forms.revision} + 1`, updatedAt: new Date() })
    .where(eq(forms.id, form.id))
    .returning();
  if (!row) throw notFound('Form');
  return row;
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

export async function listVersions(ctx: Pick<WorkspaceCtx, 'db'>, formId: string): Promise<FormVersionSummary[]> {
  const [versions, counts] = await Promise.all([
    ctx.db.select().from(formVersions).where(eq(formVersions.formId, formId)).orderBy(desc(formVersions.number)),
    ctx.db
      .select({ versionId: formResponses.versionId, n: sql<number>`count(*)::int` })
      .from(formResponses)
      .where(eq(formResponses.formId, formId))
      .groupBy(formResponses.versionId),
  ]);
  const byVersion = new Map(counts.map((c) => [c.versionId, Number(c.n)]));
  const refs = await memberRefs(ctx.db, versions.map((v) => v.publishedByUserId));
  return versions.map((v) => ({
    id: v.id,
    number: v.number,
    publishedAt: v.publishedAt.toISOString(),
    publishedBy: refs.get(v.publishedByUserId) ?? { userId: v.publishedByUserId, name: null, email: null, imageUrl: null },
    responseCount: byVersion.get(v.id) ?? 0,
  }));
}

export async function getVersion(ctx: Pick<WorkspaceCtx, 'db'>, formId: string, versionId: string): Promise<FormVersionDetail> {
  const summaries = await listVersions(ctx, formId);
  const summary = summaries.find((v) => v.id === versionId);
  if (!summary) throw notFound('Version');
  const [row] = await ctx.db.select().from(formVersions).where(eq(formVersions.id, versionId)).limit(1);
  if (!row) throw notFound('Version');
  return {
    ...summary,
    definition: formDefinitionSchema.parse(row.definition),
    theme: row.theme ? formThemeTokensSchema.parse(row.theme) : null,
  };
}
