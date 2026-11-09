/**
 * A form's integrations (`form_integrations`): list, create, change, remove and
 * check their settings against the form. What they do on a response is the
 * ProcessResponse steps (src/workflows/steps/{crm,desk,flow}.ts); what a
 * dry run would do is services/integration-test.ts.
 *
 * Settings are validated with the per-kind schema and then against the form's
 * draft definition: every question they name must exist and be of a fitting
 * type, every recalled `{{field:ref}}` / `{{hidden:name}}` must exist, and the
 * module records they point at (a CRM list, a Desk department, a Flow project,
 * the assignee) must exist. The steps act as `createdByUserId`; whoever
 * changes the settings of an integration becomes that member, so nobody can
 * widen what another member's access writes.
 */

import { and, asc, eq, isNull } from 'drizzle-orm';
import { schema } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { findField, findFieldByRef, isCompositeField, partsOf, recallTokens } from '@weldsuite/forms-engine';
import type { FormDefinition } from '@weldsuite/forms-engine/definition';
import {
  crmIntegrationConfigSchema,
  deskIntegrationConfigSchema,
  flowIntegrationConfigSchema,
  type FormIntegration,
  type FormIntegrationInput,
  type FormIntegrationKind,
  type UpdateFormIntegrationInput,
} from '@weldsuite/app-api-client/schemas/weldforms';
import { getDefinitionsForEntityType } from '@weldsuite/core-domain/custom-field-values';
import { FormsError } from '../lib/errors';
import type { WorkspaceCtx } from './context';
import { memberRefs } from './members';

const { formIntegrations, lists, helpdeskDepartments, projects, workspaceMembers } = schema;
export type IntegrationRow = typeof formIntegrations.$inferSelect;

/** Most integrations one form carries. */
export const MAX_INTEGRATIONS = 20;

export const CRM_STANDARD_FIELD_KEYS = ['firstName', 'lastName', 'email', 'directPhone', 'mobilePhone', 'title', 'department'] as const;

type Problems = Record<string, string>;

export function toIntegration(row: IntegrationRow, createdBy: FormIntegration['createdBy']): FormIntegration {
  return {
    id: row.id,
    formId: row.formId,
    kind: row.kind,
    enabled: row.enabled,
    config: row.config as Record<string, unknown>,
    createdBy,
    lastError: row.lastError,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listIntegrations(ctx: WorkspaceCtx, formId: string): Promise<FormIntegration[]> {
  const rows = await ctx.db.select().from(formIntegrations).where(eq(formIntegrations.formId, formId)).orderBy(asc(formIntegrations.createdAt));
  const refs = await memberRefs(ctx.db, rows.map((r) => r.createdByUserId));
  return rows.map((r) => toIntegration(r, refs.get(r.createdByUserId)!));
}

export async function getIntegration(ctx: WorkspaceCtx, formId: string, id: string): Promise<IntegrationRow> {
  const [row] = await ctx.db
    .select()
    .from(formIntegrations)
    .where(and(eq(formIntegrations.id, id), eq(formIntegrations.formId, formId)))
    .limit(1);
  if (!row) throw new FormsError(404, 'NOT_FOUND', 'Integration not found');
  return row;
}

export async function presentIntegration(ctx: WorkspaceCtx, row: IntegrationRow): Promise<FormIntegration> {
  return toIntegration(row, (await memberRefs(ctx.db, [row.createdByUserId])).get(row.createdByUserId)!);
}

// ── Checking the settings against the form ───────────────────────────────────

function checkTemplate(label: string, text: string, definition: FormDefinition, problems: Problems): void {
  for (const token of recallTokens(text)) {
    if (token.kind === 'field' && !findFieldByRef(definition, token.name)) problems[label] = `{{field:${token.name}}} is not a question of this form`;
    if (token.kind === 'hidden' && !definition.hidden.some((h) => h.name === token.name)) problems[label] = `{{hidden:${token.name}}} is not a hidden field of this form`;
    if (token.kind === 'var' && !definition.variables.some((v) => v.name === token.name) && token.name !== 'score') {
      problems[label] = `{{var:${token.name}}} is not a variable of this form`;
    }
  }
}

function checkFieldType(label: string, definition: FormDefinition, blockId: string | undefined, types: readonly string[], problems: Problems): void {
  if (blockId === undefined) return;
  const field = findField(definition, blockId);
  if (!field) problems[label] = 'That question is not in this form';
  else if (!types.includes(field.type)) problems[label] = `Use a ${types.join(' or ')} question`;
}

async function checkCrm(ctx: WorkspaceCtx, config: ReturnType<typeof crmIntegrationConfigSchema.parse>, definition: FormDefinition, problems: Problems): Promise<void> {
  checkFieldType('emailFieldId', definition, config.emailFieldId, ['email', 'contact_info'], problems);
  if (config.createCompany) checkFieldType('companyFieldId', definition, config.companyFieldId, ['short_text', 'contact_info'], problems);
  const custom = config.mappings.some((m) => m.crmField.startsWith('custom:'))
    ? new Set((await getDefinitionsForEntityType(ctx.db, config.target === 'lead' ? 'lead' : 'person')).map((d) => d.id))
    : new Set<string>();
  config.mappings.forEach((mapping, i) => {
    const key = `mappings.${i}`;
    const field = findField(definition, mapping.blockId);
    if (!field) {
      problems[key] = 'That question is not in this form';
      return;
    }
    if (mapping.part !== undefined && !(isCompositeField(field) && partsOf(field).some((p) => p.part === mapping.part))) {
      problems[key] = `${mapping.part} is not a part of that question`;
    }
    if (mapping.crmField.startsWith('custom:')) {
      if (!custom.has(mapping.crmField.slice('custom:'.length))) problems[key] = 'That custom field does not exist';
    } else if (!(CRM_STANDARD_FIELD_KEYS as readonly string[]).includes(mapping.crmField)) {
      problems[key] = `${mapping.crmField} is not a field a response can fill`;
    }
  });
  if (config.listId) {
    const [list] = await ctx.db.select({ kind: lists.kind }).from(lists).where(and(eq(lists.id, config.listId), isNull(lists.deletedAt))).limit(1);
    if (list?.kind !== 'person') problems.listId = 'Choose a list of people';
  }
}

async function checkDesk(ctx: WorkspaceCtx, config: ReturnType<typeof deskIntegrationConfigSchema.parse>, definition: FormDefinition, problems: Problems): Promise<void> {
  checkFieldType('requesterFieldId', definition, config.requesterFieldId, ['email', 'contact_info'], problems);
  checkTemplate('subject', config.subject, definition, problems);
  checkTemplate('body', config.body, definition, problems);
  if (config.departmentId) {
    const [department] = await ctx.db
      .select({ isActive: helpdeskDepartments.isActive })
      .from(helpdeskDepartments)
      .where(and(eq(helpdeskDepartments.id, config.departmentId), isNull(helpdeskDepartments.deletedAt)))
      .limit(1);
    if (!department || department.isActive === false) problems.departmentId = 'That team does not exist or is inactive';
  }
}

async function checkFlow(ctx: WorkspaceCtx, config: ReturnType<typeof flowIntegrationConfigSchema.parse>, definition: FormDefinition, problems: Problems): Promise<void> {
  checkFieldType('dueDateFieldId', definition, config.dueDateFieldId, ['date'], problems);
  checkTemplate('title', config.title, definition, problems);
  checkTemplate('description', config.description, definition, problems);
  if (config.projectId) {
    const [project] = await ctx.db.select({ id: projects.id }).from(projects).where(and(eq(projects.id, config.projectId), isNull(projects.deletedAt))).limit(1);
    if (!project) problems.projectId = 'That project does not exist';
  }
  if (config.assigneeUserId) {
    const [member] = await ctx.db
      .select({ id: workspaceMembers.id })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.userId, config.assigneeUserId), isNull(workspaceMembers.deletedAt)))
      .limit(1);
    if (!member) problems.assigneeUserId = 'That person is not a member of this workspace';
  }
  // A personal task needs someone to belong to: the assignee, else the member who sets this up (the step falls back to them).
}

/**
 * The settings of an integration, parsed with its kind's schema and checked
 * against the draft definition. Throws 422 `INVALID_CONFIG` with `details.fields`.
 */
export async function checkConfig(ctx: WorkspaceCtx, kind: FormIntegrationKind, raw: unknown, definition: FormDefinition): Promise<Record<string, unknown>> {
  const schemaOfKind = { crm: crmIntegrationConfigSchema, desk: deskIntegrationConfigSchema, flow: flowIntegrationConfigSchema }[kind];
  const parsed = schemaOfKind.safeParse(raw);
  if (!parsed.success) {
    const fields: Problems = {};
    for (const issue of parsed.error.issues) fields[issue.path.join('.') || 'config'] = issue.message;
    throw new FormsError(422, 'INVALID_CONFIG', 'The settings of this integration are not valid.', { fields });
  }
  const problems: Problems = {};
  if (kind === 'crm') await checkCrm(ctx, parsed.data as never, definition, problems);
  else if (kind === 'desk') await checkDesk(ctx, parsed.data as never, definition, problems);
  else await checkFlow(ctx, parsed.data as never, definition, problems);
  if (Object.keys(problems).length > 0) throw new FormsError(422, 'INVALID_CONFIG', 'The settings of this integration do not fit this form.', { fields: problems });
  return parsed.data as Record<string, unknown>;
}

// ── Writes ───────────────────────────────────────────────────────────────────

export async function createIntegration(
  ctx: WorkspaceCtx,
  form: { id: string; definition: unknown },
  userId: string,
  input: FormIntegrationInput,
): Promise<IntegrationRow> {
  const existing = await ctx.db.select({ id: formIntegrations.id }).from(formIntegrations).where(eq(formIntegrations.formId, form.id));
  if (existing.length >= MAX_INTEGRATIONS) throw new FormsError(422, 'LIMIT_REACHED', `A form can have at most ${MAX_INTEGRATIONS} integrations.`);
  const config = await checkConfig(ctx, input.kind, input.config, form.definition as FormDefinition);
  const [row] = await ctx.db
    .insert(formIntegrations)
    .values({ id: generateId('fig'), formId: form.id, kind: input.kind, config: config as never, enabled: input.enabled, createdByUserId: userId })
    .returning();
  return row!;
}

export async function updateIntegration(
  ctx: WorkspaceCtx,
  form: { id: string; definition: unknown },
  row: IntegrationRow,
  userId: string,
  input: UpdateFormIntegrationInput,
): Promise<IntegrationRow> {
  const set: Partial<typeof formIntegrations.$inferInsert> = { updatedAt: new Date() };
  if (input.enabled !== undefined) set.enabled = input.enabled;
  if (input.config !== undefined) {
    set.config = (await checkConfig(ctx, row.kind, input.config, form.definition as FormDefinition)) as never;
    // Whoever decides what it writes writes it with their own access; the old error is no longer true.
    set.createdByUserId = userId;
    set.lastError = null;
  }
  const [updated] = await ctx.db.update(formIntegrations).set(set).where(eq(formIntegrations.id, row.id)).returning();
  return updated!;
}

export async function deleteIntegration(ctx: WorkspaceCtx, row: IntegrationRow): Promise<void> {
  await ctx.db.delete(formIntegrations).where(eq(formIntegrations.id, row.id));
}

