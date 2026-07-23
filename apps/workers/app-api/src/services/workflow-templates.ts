/**
 * Workflow templates service — CRUD, category aggregation, create from
 * workflow, and "use template" (materializes a draft workflow + increments
 * the template's usage count).
 */

import { and, desc, eq, isNull, like, lt, or, sql } from 'drizzle-orm';
import { schema, type Database } from '../db';
import { generateId } from '../lib/id';

const { workflowTemplates, workflows } = schema;

export interface ListTemplatesParams {
  search?: string;
  category?: string;
  difficulty?: string;
  cursor?: string;
  limit?: number;
}

export async function listTemplates(db: Database, params: ListTemplatesParams) {
  const limit = Math.min(params.limit ?? 25, 100);

  const filterConditions: any[] = [isNull(workflowTemplates.deletedAt)];
  if (params.search) {
    filterConditions.push(
      or(
        like(workflowTemplates.name, `%${params.search}%`),
        like(workflowTemplates.description, `%${params.search}%`),
      )!,
    );
  }
  if (params.category) filterConditions.push(eq(workflowTemplates.category, params.category));
  if (params.difficulty) filterConditions.push(eq(workflowTemplates.difficulty, params.difficulty));

  const conditions = [...filterConditions];
  if (params.cursor) conditions.push(lt(workflowTemplates.id, params.cursor));

  const [rows, countRes] = await Promise.all([
    db
      .select()
      .from(workflowTemplates)
      .where(and(...conditions))
      .orderBy(desc(workflowTemplates.updatedAt))
      .limit(limit + 1),
    db.select({ count: sql<number>`count(*)::int` }).from(workflowTemplates).where(and(...filterConditions)),
  ]);

  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const cursor = hasMore && data.length > 0 ? data[data.length - 1].id : null;
  return { data, totalCount: Number(countRes[0]?.count ?? 0), hasMore, cursor };
}

export async function getTemplate(db: Database, id: string) {
  const [row] = await db
    .select()
    .from(workflowTemplates)
    .where(and(eq(workflowTemplates.id, id), isNull(workflowTemplates.deletedAt)))
    .limit(1);
  return row ?? null;
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
    triggers: (data.triggers ?? []) as any,
    steps: (data.steps ?? []) as any,
    settings: (data.settings ?? {}) as any,
    tags: (data.tags as string[]) ?? [],
    icon: (data.icon as string) ?? null,
    authorId: userId,
    createdAt: now,
    updatedAt: now,
  });
  return { id };
}

export async function updateTemplate(db: Database, id: string, data: Record<string, unknown>) {
  const [existing] = await db
    .select()
    .from(workflowTemplates)
    .where(and(eq(workflowTemplates.id, id), isNull(workflowTemplates.deletedAt)))
    .limit(1);
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

export async function getTemplateCategories(db: Database) {
  const rows = await db
    .select({ category: workflowTemplates.category })
    .from(workflowTemplates)
    .where(isNull(workflowTemplates.deletedAt));

  const counts: Record<string, number> = {};
  for (const r of rows) {
    const cat = r.category || 'other';
    counts[cat] = (counts[cat] || 0) + 1;
  }
  return Object.entries(counts).map(([id, count]) => ({
    id,
    name: id.charAt(0).toUpperCase() + id.slice(1).replace(/_/g, ' '),
    count,
  }));
}

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

  const id = generateId('tmpl');
  const now = new Date();
  await db.insert(workflowTemplates).values({
    id,
    name: overrides?.name || `${workflow.name} Template`,
    description: overrides?.description || workflow.description,
    category: overrides?.category || 'custom',
    difficulty: 'beginner',
    triggers: (workflow.triggers ?? []) as any,
    steps: (workflow.steps ?? []) as any,
    settings: (workflow.settings ?? {}) as any,
    tags: workflow.tags ?? [],
    authorId: userId,
    createdAt: now,
    updatedAt: now,
  });
  return { id };
}

export async function useTemplate(
  db: Database,
  templateId: string,
  userId: string,
  overrides?: { name?: string; description?: string; activate?: boolean },
) {
  const [template] = await db
    .select()
    .from(workflowTemplates)
    .where(and(eq(workflowTemplates.id, templateId), isNull(workflowTemplates.deletedAt)))
    .limit(1);
  if (!template) return null;

  const workflowId = generateId('wf');
  const now = new Date();
  await db.insert(workflows).values({
    id: workflowId,
    name: overrides?.name || template.name,
    description: overrides?.description || template.description,
    status: overrides?.activate ? 'active' : 'draft',
    triggers: (template.triggers ?? []) as any,
    steps: (template.steps ?? []) as any,
    settings: (template.settings ?? {}) as any,
    tags: template.tags ?? [],
    templateId,
    createdBy: userId,
    version: 1,
    executionCount: 0,
    successCount: 0,
    failureCount: 0,
    createdAt: now,
    updatedAt: now,
  });

  await db
    .update(workflowTemplates)
    .set({
      usageCount: sql`COALESCE(${workflowTemplates.usageCount}, 0) + 1`,
      updatedAt: now,
    })
    .where(eq(workflowTemplates.id, templateId));

  return { id: workflowId, templateId, name: overrides?.name || template.name };
}
