/**
 * Forms: the DTOs, create (blank, from a template, from a definition), save
 * the draft with optimistic concurrency, duplicate, delete, the access list.
 * Pure functions over a `WorkspaceCtx`, no Hono context.
 */

import { and, asc, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { atomically } from '@weldsuite/worker-kit/atomically';
import { masterSchema, schema } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import {
  createBlankDefinition,
  STARTER_TEMPLATES,
  type FormDefinition,
} from '@weldsuite/forms-engine';
import { formDefinitionSchema } from '@weldsuite/forms-engine/definition';
import {
  formSettingsSchema,
  type CreateFormInput,
  type FormAccessEntry,
  type FormDetail,
  type FormSettings,
  type FormSummary,
  type FormUserRef,
  type ListFormsQuery,
  type SetFormAccessInput,
  type UpdateFormInput,
} from '@weldsuite/app-api-client/schemas/weldforms';
import { FormsError, notFound } from '../lib/errors';
import type { MemberGrants } from './access';
import { formPermissions, type FormRelation } from './access';
import { publicFormUrl, type WorkspaceCtx } from './context';
import { dropPublicCache, refreshPublicCache } from './public-cache';
import { memberRef, memberRefs } from './members';

const {
  forms,
  formVersions,
  formFolders,
  formThemes,
  formAccess,
  formResponses,
  formResponseFiles,
  formResponseActions,
  formInvitations,
  formIntegrations,
  formSubscriptions,
  formAiSummaries,
  formSettings: formSettingsTable,
} = schema;
const { formLinkRegistry, formInvitationRegistry } = masterSchema;

export type FormRow = typeof forms.$inferSelect;
type VersionRow = typeof formVersions.$inferSelect;

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

export function settingsOf(row: Pick<FormRow, 'settings'>): FormSettings {
  return formSettingsSchema.parse(row.settings ?? {});
}

export function toSummary(ctx: Pick<WorkspaceCtx, 'env'>, row: FormRow, owner: FormUserRef): FormSummary {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    folderId: row.folderId,
    layout: formDefinitionSchema.parse(row.definition).presentation.layout,
    publicId: row.publicId,
    publicUrl: publicFormUrl(ctx.env, row.publicId),
    access: row.access,
    respondentMode: settingsOf(row).respondentMode,
    owner,
    responseCount: row.responseCount,
    lastResponseAt: iso(row.lastResponseAt),
    hasUnpublishedChanges: row.hasUnpublishedChanges,
    publishedAt: iso(row.publishedAt),
    closedAt: iso(row.closedAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface DetailExtras {
  owner: FormUserRef;
  relation: FormRelation;
  grants: MemberGrants;
  moderation: FormDetail['moderation'];
}

/** The detail: the summary plus the draft, settings, revision, published version and what the member may do. */
export async function toDetail(ctx: Pick<WorkspaceCtx, 'env' | 'db'>, row: FormRow, extras: DetailExtras): Promise<FormDetail> {
  const [version] = row.publishedVersionId
    ? await ctx.db.select().from(formVersions).where(eq(formVersions.id, row.publishedVersionId)).limit(1)
    : [];
  return {
    ...toSummary(ctx, row, extras.owner),
    definition: formDefinitionSchema.parse(row.definition),
    settings: settingsOf(row),
    themeId: row.themeId,
    revision: row.revision,
    publishedVersion: version ? { id: version.id, number: version.number, publishedAt: version.publishedAt.toISOString() } : null,
    permissions: formPermissions(extras.relation, extras.grants),
    moderation: extras.moderation,
  };
}

/** What staff did to the public link, from the master registry row. */
export async function moderationOf(ctx: Pick<WorkspaceCtx, 'master'>, row: Pick<FormRow, 'publicId'>): Promise<FormDetail['moderation']> {
  if (!row.publicId) return null;
  const [link] = await ctx.master.select().from(formLinkRegistry).where(eq(formLinkRegistry.publicId, row.publicId)).limit(1);
  if (!link) return null;
  if (link.suspendedAt) return { state: 'suspended', reason: link.suspendedReason };
  if (link.heldAt) return { state: 'held', reason: link.heldReason };
  return null;
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

const DEFAULT_LIMIT = 50;

/** `%`, `_` and `\` taken literally in a LIKE pattern. */
const escapeLike = (text: string) => text.replace(/[%_\\]/g, (m) => `\\${m}`);

/** The forms a member without `forms:manage` sees: workspace-wide ones, their own, and those shared with them. */
async function visibleTo(ctx: Pick<WorkspaceCtx, 'db'>, userId: string): Promise<SQL | undefined> {
  const mine = await ctx.db.select({ formId: formAccess.formId }).from(formAccess).where(eq(formAccess.userId, userId));
  return or(eq(forms.access, 'workspace'), eq(forms.ownerUserId, userId), mine.length ? inArray(forms.id, mine.map((m) => m.formId)) : undefined);
}

/** The folder, status and title filters of the list. */
function listFilters(query: ListFormsQuery): SQL[] {
  const conditions: SQL[] = [];
  if (query.folderId === 'none') conditions.push(isNull(forms.folderId));
  else if (query.folderId) conditions.push(eq(forms.folderId, query.folderId));
  if (query.status) conditions.push(eq(forms.status, query.status));
  if (query.q) conditions.push(ilike(forms.title, `%${escapeLike(query.q)}%`));
  return conditions;
}

function listOrder(sort: ListFormsQuery['sort']): SQL[] {
  switch (sort) {
    case 'created':
      return [desc(forms.createdAt)];
    case 'title':
      return [asc(forms.title), asc(forms.id)];
    case 'responses':
      return [desc(forms.responseCount), desc(forms.updatedAt)];
    default:
      return [desc(forms.updatedAt), desc(forms.id)];
  }
}

export async function listForms(
  ctx: Pick<WorkspaceCtx, 'env' | 'db'>,
  userId: string,
  grants: MemberGrants,
  query: ListFormsQuery,
): Promise<{ rows: FormSummary[]; total: number; next: string | null }> {
  const conditions: SQL[] = [];
  if (!grants.manage) {
    const visible = await visibleTo(ctx, userId);
    if (visible) conditions.push(visible);
  }
  conditions.push(...listFilters(query));
  const where = conditions.length ? and(...conditions) : undefined;
  const order = listOrder(query.sort);

  const limit = query.limit ?? DEFAULT_LIMIT;
  const offset = query.cursor ? Math.max(0, Number(query.cursor) || 0) : 0;
  const [rows, [count]] = await Promise.all([
    ctx.db.select().from(forms).where(where).orderBy(...order).limit(limit).offset(offset),
    ctx.db.select({ n: sql<number>`count(*)::int` }).from(forms).where(where),
  ]);
  const owners = await memberRefs(ctx.db, rows.map((r) => r.ownerUserId));
  const total = Number(count?.n ?? 0);
  const next = offset + rows.length;
  return {
    rows: rows.map((r) => toSummary(ctx, r, owners.get(r.ownerUserId) ?? { userId: r.ownerUserId, name: null, email: null, imageUrl: null })),
    total,
    next: next < total ? String(next) : null,
  };
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/** The theme new forms start with: the workspace default. */
async function defaultThemeId(ctx: Pick<WorkspaceCtx, 'db'>): Promise<string | null> {
  const [settings] = await ctx.db.select({ id: formSettingsTable.defaultThemeId }).from(formSettingsTable).limit(1);
  if (settings?.id) return settings.id;
  const [theme] = await ctx.db.select({ id: formThemes.id }).from(formThemes).where(eq(formThemes.isDefault, true)).limit(1);
  return theme?.id ?? null;
}

function startingDefinition(input: CreateFormInput): FormDefinition {
  let definition: FormDefinition;
  if (input.definition) {
    definition = input.definition;
  } else if (input.templateId) {
    const template = STARTER_TEMPLATES.find((t) => t.id === input.templateId);
    if (!template) throw new FormsError(400, 'TEMPLATE_NOT_FOUND', `Template '${input.templateId}' does not exist`);
    definition = formDefinitionSchema.parse(template.definition);
  } else {
    definition = createBlankDefinition();
  }
  return input.layout ? { ...definition, presentation: { ...definition.presentation, layout: input.layout } } : definition;
}

export async function createForm(ctx: WorkspaceCtx, userId: string, input: CreateFormInput): Promise<FormRow> {
  if (input.folderId) await requireFolder(ctx, input.folderId);
  const definition = startingDefinition(input);
  const id = generateId('frm');
  const themeId = await defaultThemeId(ctx);
  let created: FormRow | undefined;
  await atomically(ctx.db, (db) => [
    db
      .insert(forms)
      .values({
        id,
        folderId: input.folderId ?? null,
        title: input.title,
        definition,
        settings: formSettingsSchema.parse({}),
        themeId,
        ownerUserId: userId,
      }),
    // The owner is subscribed to responses from the start.
    db.insert(formSubscriptions).values({ id: generateId('fsb'), formId: id, userId, mode: 'instant' }),
  ]);
  [created] = await ctx.db.select().from(forms).where(eq(forms.id, id)).limit(1);
  if (!created) throw new FormsError(404, 'NOT_FOUND', 'Form not found');
  return created;
}

async function requireFolder(ctx: Pick<WorkspaceCtx, 'db'>, folderId: string): Promise<void> {
  const [folder] = await ctx.db.select({ id: formFolders.id }).from(formFolders).where(eq(formFolders.id, folderId)).limit(1);
  if (!folder) throw notFound('Folder');
}

// ---------------------------------------------------------------------------
// Save the draft
// ---------------------------------------------------------------------------

/**
 * Saves the draft. `input.revision` is the revision the editor loaded: when
 * somebody saved in between the update matches no row and answers 409
 * `REVISION_CONFLICT` (CRM-004), and the builder reloads. Operational settings
 * (and the title) apply to the live form at once, so they refresh the public cache.
 */
async function requireTheme(ctx: Pick<WorkspaceCtx, 'db'>, themeId: string): Promise<void> {
  const [theme] = await ctx.db.select({ id: formThemes.id }).from(formThemes).where(eq(formThemes.id, themeId)).limit(1);
  if (!theme) throw notFound('Theme');
}

/** The columns a save changes: only what the input carries, and the unpublished-changes flag when the content of a published form changes. */
function draftChanges(form: FormRow, input: UpdateFormInput, settings: FormSettings | undefined) {
  const changesContent = input.definition !== undefined || input.themeId !== undefined;
  return {
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.folderId !== undefined ? { folderId: input.folderId } : {}),
    ...(input.definition !== undefined ? { definition: input.definition } : {}),
    ...(settings ? { settings } : {}),
    ...(input.themeId !== undefined ? { themeId: input.themeId } : {}),
    ...(input.access !== undefined ? { access: input.access } : {}),
    ...(changesContent && form.publishedVersionId ? { hasUnpublishedChanges: true } : {}),
  };
}

/** 409 `REVISION_CONFLICT` with the revision now stored, or 404 when the form is gone. */
async function revisionConflict(ctx: Pick<WorkspaceCtx, 'db'>, formId: string): Promise<FormsError> {
  const [current] = await ctx.db.select({ revision: forms.revision }).from(forms).where(eq(forms.id, formId)).limit(1);
  if (!current) return notFound('Form');
  return new FormsError(409, 'REVISION_CONFLICT', 'Somebody else saved this form. Reload it to continue.', { currentRevision: current.revision });
}

export async function updateForm(ctx: WorkspaceCtx, form: FormRow, input: UpdateFormInput): Promise<FormRow> {
  if (input.folderId) await requireFolder(ctx, input.folderId);
  if (input.themeId) await requireTheme(ctx, input.themeId);
  const settings = input.settings ? formSettingsSchema.parse({ ...settingsOf(form), ...input.settings }) : undefined;

  const [row] = await ctx.db
    .update(forms)
    .set({
      ...draftChanges(form, input, settings),
      revision: sql`${forms.revision} + 1`,
      updatedAt: new Date(),
    })
    .where(and(eq(forms.id, form.id), eq(forms.revision, input.revision)))
    .returning();
  if (!row) throw await revisionConflict(ctx, form.id);
  if (row.publicId && (settings || input.title !== undefined)) await refreshPublicCache(ctx, row);
  return row;
}

// ---------------------------------------------------------------------------
// Duplicate, delete
// ---------------------------------------------------------------------------

export async function duplicateForm(ctx: WorkspaceCtx, source: FormRow, userId: string, title?: string): Promise<FormRow> {
  const id = generateId('frm');
  const copyTitle = (title ?? `${source.title} (copy)`).slice(0, 255);
  await atomically(ctx.db, (db) => [
    db.insert(forms).values({
      id,
      folderId: source.folderId,
      title: copyTitle,
      definition: source.definition,
      settings: source.settings,
      themeId: source.themeId,
      ownerUserId: userId,
    }),
    db.insert(formSubscriptions).values({ id: generateId('fsb'), formId: id, userId, mode: 'instant' }),
  ]);
  const [row] = await ctx.db.select().from(forms).where(eq(forms.id, id)).limit(1);
  if (!row) throw notFound('Form');
  return row;
}

/**
 * Deletes the form with its versions, responses, files, invitations,
 * integrations and links (master registry rows and the public cache entry).
 * Returns the private-bucket keys of its files; the caller deletes them after
 * the response.
 */
export async function deleteForm(ctx: WorkspaceCtx, form: FormRow): Promise<string[]> {
  const files = await ctx.db.select({ key: formResponseFiles.storageKey }).from(formResponseFiles).where(eq(formResponseFiles.formId, form.id));
  await atomically(ctx.db, (db) => [
    db.delete(formAiSummaries).where(eq(formAiSummaries.formId, form.id)),
    db.delete(formResponseActions).where(eq(formResponseActions.formId, form.id)),
    db.delete(formResponseFiles).where(eq(formResponseFiles.formId, form.id)),
    db.delete(formResponses).where(eq(formResponses.formId, form.id)),
    db.delete(formInvitations).where(eq(formInvitations.formId, form.id)),
    db.delete(formIntegrations).where(eq(formIntegrations.formId, form.id)),
    db.delete(formSubscriptions).where(eq(formSubscriptions.formId, form.id)),
    db.delete(formAccess).where(eq(formAccess.formId, form.id)),
    db.delete(formVersions).where(eq(formVersions.formId, form.id)),
    db.delete(forms).where(eq(forms.id, form.id)),
  ]);
  // The registries only route; with the form gone the links must stop answering.
  await ctx.master.delete(formLinkRegistry).where(and(eq(formLinkRegistry.workspaceId, ctx.workspaceId), eq(formLinkRegistry.formId, form.id)));
  await ctx.master.delete(formInvitationRegistry).where(and(eq(formInvitationRegistry.workspaceId, ctx.workspaceId), eq(formInvitationRegistry.formId, form.id)));
  if (form.publicId) await dropPublicCache(ctx.env.WORKSPACE_CACHE, form.publicId);
  return files.map((f) => f.key);
}

// ---------------------------------------------------------------------------
// Access list
// ---------------------------------------------------------------------------

export async function listAccess(ctx: Pick<WorkspaceCtx, 'db'>, formId: string): Promise<FormAccessEntry[]> {
  const rows = await ctx.db.select().from(formAccess).where(eq(formAccess.formId, formId)).orderBy(asc(formAccess.createdAt));
  const refs = await memberRefs(ctx.db, rows.map((r) => r.userId));
  return rows.map((r) => ({ user: refs.get(r.userId) ?? { userId: r.userId, name: null, email: null, imageUrl: null }, role: r.role }));
}

/** Replaces the access list. The owner never needs an entry. */
export async function setAccess(ctx: Pick<WorkspaceCtx, 'db'>, form: FormRow, input: SetFormAccessInput): Promise<FormAccessEntry[]> {
  const entries = new Map<string, SetFormAccessInput['entries'][number]>();
  for (const entry of input.entries) if (entry.userId !== form.ownerUserId) entries.set(entry.userId, entry);
  await atomically(ctx.db, (db) => [
    db.delete(formAccess).where(eq(formAccess.formId, form.id)),
    ...(entries.size
      ? [db.insert(formAccess).values([...entries.values()].map((e) => ({ id: generateId('fac'), formId: form.id, userId: e.userId, role: e.role })))]
      : []),
    db.update(forms).set({ updatedAt: new Date() }).where(eq(forms.id, form.id)),
  ]);
  return listAccess(ctx, form.id);
}

export { memberRef };
export type { VersionRow };
