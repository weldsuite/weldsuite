/**
 * Workflow templates service — the gallery (workspace templates plus the
 * built-in starter set), "save as template" from a workflow, and "use
 * template" (creates a draft workflow + bumps the template's usage count).
 *
 * Built-in templates are code (`@weldsuite/app-api-client/schemas/weldconnect-templates`),
 * translated with `@weldsuite/i18n/locales/<locale>/weldconnect-templates`,
 * read-only and identical in every workspace; workspace templates are rows of
 * `workflow_templates`. Both are returned in the same `WorkflowTemplateItem`
 * shape, with what still needs filling in computed by the activation gate.
 */

import { and, desc, eq, ilike, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import {
  BUILT_IN_WORKFLOW_TEMPLATES,
  findBuiltInTemplate,
  isBuiltInTemplateId,
  resolveBuiltInTemplate,
  templateProviders,
  toTemplateLocale,
  type BuiltInTemplateCatalog,
  type ResolvedBuiltInTemplate,
  type TemplateStep,
  type TemplateTrigger,
  type WorkflowFromTemplate,
  type WorkflowTemplateItem,
  type WorkflowTemplateLocale,
} from '@weldsuite/app-api-client/schemas/weldconnect-templates';
import { weldconnectTemplates as enTemplateStrings } from '@weldsuite/i18n/locales/en/weldconnect-templates';
import { weldconnectTemplates as nlTemplateStrings } from '@weldsuite/i18n/locales/nl/weldconnect-templates';
import { isSequenceWorkflow, SEQUENCE_WORKFLOW_TAG, validateWeldConnectWorkflow } from './weldconnect-mvp';
import { createWorkflow } from './workflows';
import type { ScheduleIndexSync } from '../lib/schedule-index';
import type { WebhookSyncContext } from './workflow-webhook-sync';

const { workflowTemplates, workflows } = schema;

// Typed against the shared catalog shape: a template key missing from a
// locale file fails the type-check here.
const TEMPLATE_STRINGS: Record<WorkflowTemplateLocale, BuiltInTemplateCatalog> = {
  en: enTemplateStrings,
  nl: nlTemplateStrings,
};

type WorkflowTemplateRow = typeof workflowTemplates.$inferSelect;

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function setupIssuesOf(triggers: unknown, steps: unknown) {
  return validateWeldConnectWorkflow({ triggers, steps });
}

export function resolveBuiltIn(id: string, locale: unknown): ResolvedBuiltInTemplate | null {
  const definition = findBuiltInTemplate(id);
  if (!definition) return null;
  return resolveBuiltInTemplate(definition, TEMPLATE_STRINGS[toTemplateLocale(locale)], TEMPLATE_STRINGS.en);
}

function builtInItem(template: ResolvedBuiltInTemplate): WorkflowTemplateItem {
  return {
    id: template.id,
    source: 'builtin',
    name: template.name,
    description: template.description,
    category: template.category,
    icon: template.icon,
    triggers: template.triggers,
    steps: template.steps,
    requiredIntegrations: templateProviders(template.steps),
    setupIssues: setupIssuesOf(template.triggers, template.steps),
    usageCount: 0,
    authorId: null,
    createdAt: null,
    updatedAt: null,
  };
}

function workspaceItem(row: WorkflowTemplateRow): WorkflowTemplateItem {
  const triggers = asArray<TemplateTrigger>(row.triggers);
  const steps = asArray<TemplateStep>(row.steps);
  return {
    id: row.id,
    source: 'workspace',
    name: row.name,
    description: row.description ?? null,
    category: row.category,
    icon: row.icon ?? null,
    triggers,
    steps,
    requiredIntegrations: templateProviders(steps),
    setupIssues: setupIssuesOf(triggers, steps),
    usageCount: row.usageCount ?? 0,
    authorId: row.authorId ?? null,
    createdAt: row.createdAt ? row.createdAt.toISOString() : null,
    updatedAt: row.updatedAt ? row.updatedAt.toISOString() : null,
  };
}

export interface ListTemplatesParams {
  search?: string;
  category?: string;
  /** `builtin` | `workspace`; both when absent. */
  source?: string;
  locale?: string;
  cursor?: string;
  limit?: number;
}

function matchesSearch(template: ResolvedBuiltInTemplate, search: string | undefined): boolean {
  if (!search) return true;
  const needle = search.toLowerCase();
  return template.name.toLowerCase().includes(needle) || template.description.toLowerCase().includes(needle);
}

/**
 * Built-ins (first page only — there are a handful, never paginated) followed
 * by the workspace's templates, newest first, cursor-paginated. `totalCount`
 * counts both.
 */
export async function listTemplates(db: Database, params: ListTemplatesParams) {
  const limit = Math.min(Math.max(params.limit ?? 25, 1), 100);

  const builtIns =
    params.source === 'workspace'
      ? []
      : BUILT_IN_WORKFLOW_TEMPLATES.map((definition) =>
          resolveBuiltInTemplate(definition, TEMPLATE_STRINGS[toTemplateLocale(params.locale)], TEMPLATE_STRINGS.en),
        ).filter(
          (template) => (!params.category || template.category === params.category) && matchesSearch(template, params.search),
        );

  if (params.source === 'builtin') {
    return { data: builtIns.map(builtInItem), totalCount: builtIns.length, hasMore: false, cursor: null };
  }

  const filters: SQL[] = [isNull(workflowTemplates.deletedAt)];
  if (params.search) {
    const pattern = `%${params.search}%`;
    const searchFilter = or(ilike(workflowTemplates.name, pattern), ilike(workflowTemplates.description, pattern));
    if (searchFilter) filters.push(searchFilter);
  }
  if (params.category) filters.push(eq(workflowTemplates.category, params.category));

  const pageFilters = params.cursor ? [...filters, lt(workflowTemplates.id, params.cursor)] : filters;
  const [rows, countRes] = await Promise.all([
    db
      .select()
      .from(workflowTemplates)
      .where(and(...pageFilters))
      .orderBy(desc(workflowTemplates.id))
      .limit(limit + 1),
    db.select({ count: sql<number>`count(*)::int` }).from(workflowTemplates).where(and(...filters)),
  ]);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const cursor = hasMore && page.length > 0 ? page[page.length - 1].id : null;
  const firstPageBuiltIns = params.cursor ? [] : builtIns.map(builtInItem);
  return {
    data: [...firstPageBuiltIns, ...page.map(workspaceItem)],
    totalCount: Number(countRes[0]?.count ?? 0) + builtIns.length,
    hasMore,
    cursor,
  };
}

async function getTemplateRow(db: Database, id: string) {
  const [row] = await db
    .select()
    .from(workflowTemplates)
    .where(and(eq(workflowTemplates.id, id), isNull(workflowTemplates.deletedAt)))
    .limit(1);
  return row ?? null;
}

/** A built-in (by its `builtin_` id) or a workspace template; null when neither exists. */
export async function getTemplate(db: Database, id: string, locale?: string): Promise<WorkflowTemplateItem | null> {
  if (isBuiltInTemplateId(id)) {
    const builtIn = resolveBuiltIn(id, locale);
    return builtIn ? builtInItem(builtIn) : null;
  }
  const row = await getTemplateRow(db, id);
  return row ? workspaceItem(row) : null;
}

export async function createTemplate(db: Database, data: Record<string, unknown>, userId: string) {
  const id = generateId('tmpl');
  const now = new Date();
  await db.insert(workflowTemplates).values({
    id,
    name: String(data.name),
    description: (data.description as string | null) ?? null,
    category: (data.category as string) || 'custom',
    difficulty: (data.difficulty as string) || 'beginner',
    triggers: (data.triggers ?? []) as WorkflowTemplateRow['triggers'],
    steps: (data.steps ?? []) as WorkflowTemplateRow['steps'],
    settings: (data.settings ?? {}) as WorkflowTemplateRow['settings'],
    tags: (data.tags as string[]) ?? [],
    icon: (data.icon as string) ?? null,
    authorId: userId,
    createdAt: now,
    updatedAt: now,
  });
  return { id };
}

/** Workspace templates only: null when the row doesn't exist (built-ins are never stored). */
export async function updateTemplate(db: Database, id: string, data: Record<string, unknown>) {
  const existing = await getTemplateRow(db, id);
  if (!existing) return null;

  const update: Record<string, unknown> = { updatedAt: new Date() };
  for (const k of ['name', 'description', 'category', 'difficulty', 'triggers', 'steps', 'settings', 'tags', 'icon'] as const) {
    if (data[k] !== undefined) update[k] = data[k];
  }
  await db.update(workflowTemplates).set(update).where(eq(workflowTemplates.id, id));
  return { id };
}

export async function deleteTemplate(db: Database, id: string) {
  await db
    .update(workflowTemplates)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(workflowTemplates.id, id), isNull(workflowTemplates.deletedAt)));
}

/** Template count per category, built-ins included. */
export async function getTemplateCategories(db: Database) {
  const rows = await db
    .select({ category: workflowTemplates.category })
    .from(workflowTemplates)
    .where(isNull(workflowTemplates.deletedAt));

  const counts: Record<string, number> = {};
  for (const category of [...BUILT_IN_WORKFLOW_TEMPLATES.map((t) => t.category), ...rows.map((r) => r.category)]) {
    const key = category || 'custom';
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.entries(counts).map(([id, count]) => ({
    id,
    name: id.charAt(0).toUpperCase() + id.slice(1).replaceAll('_', ' '),
    count,
  }));
}

export class SequenceTemplateError extends Error {
  constructor() {
    super('CRM sequences cannot be saved as WeldConnect templates');
  }
}

/**
 * "Save as template": a snapshot of the workflow's triggers, steps and
 * settings. CRM sequences share the `workflows` table but not the editor, so
 * they are refused. Null when the workflow doesn't exist.
 */
export async function createTemplateFromWorkflow(
  db: Database,
  workflowId: string,
  userId: string,
  overrides?: { name?: string; description?: string; category?: string },
) {
  const [workflow] = await db
    .select()
    .from(workflows)
    .where(and(eq(workflows.id, workflowId), isNull(workflows.deletedAt)))
    .limit(1);
  if (!workflow) return null;
  if (isSequenceWorkflow(workflow.tags)) throw new SequenceTemplateError();

  const id = generateId('tmpl');
  const now = new Date();
  const name = overrides?.name || workflow.name;
  await db.insert(workflowTemplates).values({
    id,
    name,
    description: overrides?.description ?? workflow.description,
    category: overrides?.category || 'custom',
    difficulty: 'beginner',
    triggers: workflow.triggers ?? [],
    steps: workflow.steps ?? [],
    settings: workflow.settings ?? {},
    tags: workflow.tags ?? [],
    authorId: userId,
    createdAt: now,
    updatedAt: now,
  });
  return { id, name };
}

export interface CreateFromTemplateOptions {
  name?: string;
  description?: string;
  /** Language of a built-in template's step names and texts. */
  locale?: string;
  scheduleSync?: ScheduleIndexSync;
  webhookSync?: WebhookSyncContext;
}

/**
 * "Use template": a new DRAFT workflow with the template's triggers and steps
 * (branch structure included), owned by `userId`. It goes through the normal
 * create path, so webhook triggers get their URL straight away; activating it
 * later runs the gate like any other workflow. Null when the template doesn't
 * exist.
 */
export async function createWorkflowFromTemplate(
  db: Database,
  templateId: string,
  userId: string,
  options: CreateFromTemplateOptions = {},
): Promise<WorkflowFromTemplate | null> {
  let source: { name: string; description: string | null; triggers: unknown[]; steps: unknown[]; settings: Record<string, unknown>; tags: string[] };

  if (isBuiltInTemplateId(templateId)) {
    const builtIn = resolveBuiltIn(templateId, options.locale);
    if (!builtIn) return null;
    source = { name: builtIn.name, description: builtIn.description, triggers: builtIn.triggers, steps: builtIn.steps, settings: {}, tags: [] };
  } else {
    const row = await getTemplateRow(db, templateId);
    if (!row) return null;
    source = {
      name: row.name,
      description: row.description ?? null,
      triggers: asArray(row.triggers),
      steps: asArray(row.steps),
      settings: (row.settings ?? {}) as Record<string, unknown>,
      // Never turn a WeldConnect workflow into a CRM sequence.
      tags: (row.tags ?? []).filter((tag) => tag !== SEQUENCE_WORKFLOW_TAG),
    };
  }

  const name = options.name || source.name;
  const { id } = await createWorkflow(
    db,
    {
      name,
      description: options.description ?? source.description,
      status: 'draft',
      triggers: source.triggers,
      steps: source.steps,
      settings: source.settings,
      tags: source.tags,
      templateId,
    },
    userId,
    options.scheduleSync,
    options.webhookSync,
  );

  if (!isBuiltInTemplateId(templateId)) {
    await db
      .update(workflowTemplates)
      .set({ usageCount: sql`COALESCE(${workflowTemplates.usageCount}, 0) + 1`, updatedAt: new Date() })
      .where(eq(workflowTemplates.id, templateId));
  }

  return { id, templateId, name };
}
