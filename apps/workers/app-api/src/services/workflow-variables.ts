/**
 * Workflow variables service — CRUD plus the two "scope" queries the editor
 * needs (`/global`, `/workflow/:workflowId`). Secrets are masked in the
 * response payload; the raw value is never returned to the client.
 */

import { and, desc, eq, isNull, like, lt, or, sql } from 'drizzle-orm';
import { schema, type Database } from '../db';
import { generateId } from '../lib/id';

const { workflowVariables } = schema;

export interface ListVariablesParams {
  search?: string;
  workflowId?: string;
  scope?: string;
  isSecret?: boolean;
  cursor?: string;
  limit?: number;
}

type Variable = typeof workflowVariables.$inferSelect;

function maskSecret<T extends { isSecret: boolean | null; value: unknown }>(v: T): T {
  return v.isSecret ? { ...v, value: '********' } : v;
}

export async function listVariables(db: Database, params: ListVariablesParams) {
  const limit = Math.min(params.limit ?? 25, 100);

  const filterConditions: any[] = [isNull(workflowVariables.deletedAt)];
  if (params.search) filterConditions.push(like(workflowVariables.name, `%${params.search}%`));
  if (params.workflowId) filterConditions.push(eq(workflowVariables.workflowId, params.workflowId));
  if (params.scope) filterConditions.push(eq(workflowVariables.scope, params.scope));
  if (params.isSecret !== undefined) filterConditions.push(eq(workflowVariables.isSecret, params.isSecret));

  const conditions = [...filterConditions];
  if (params.cursor) conditions.push(lt(workflowVariables.id, params.cursor));

  const [rows, countRes] = await Promise.all([
    db
      .select()
      .from(workflowVariables)
      .where(and(...conditions))
      .orderBy(desc(workflowVariables.updatedAt))
      .limit(limit + 1),
    db.select({ count: sql<number>`count(*)::int` }).from(workflowVariables).where(and(...filterConditions)),
  ]);

  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const cursor = hasMore && data.length > 0 ? data[data.length - 1].id : null;
  return { data: data.map(maskSecret), totalCount: Number(countRes[0]?.count ?? 0), hasMore, cursor };
}

export async function getVariable(db: Database, id: string) {
  const [row] = await db
    .select()
    .from(workflowVariables)
    .where(and(eq(workflowVariables.id, id), isNull(workflowVariables.deletedAt)))
    .limit(1);
  return row ? maskSecret(row) : null;
}

export async function getGlobalVariables(db: Database) {
  const rows = await db
    .select()
    .from(workflowVariables)
    .where(and(eq(workflowVariables.scope, 'global'), isNull(workflowVariables.deletedAt)))
    .orderBy(workflowVariables.name);
  return rows.map(maskSecret);
}

/**
 * Variables available inside a workflow — own scope plus all globals.
 * Returns the editor-friendly shape (name/type only — no values exposed).
 */
export async function getWorkflowVariables(db: Database, workflowId: string) {
  return db
    .select({
      name: workflowVariables.name,
      type: workflowVariables.type,
      isSecret: workflowVariables.isSecret,
      scope: workflowVariables.scope,
    })
    .from(workflowVariables)
    .where(
      and(
        or(eq(workflowVariables.workflowId, workflowId), eq(workflowVariables.scope, 'global')),
        isNull(workflowVariables.deletedAt),
      ),
    )
    .orderBy(workflowVariables.name);
}

export async function createVariable(db: Database, data: Record<string, unknown>, userId: string) {
  const id = generateId('var');
  const now = new Date();
  const scope = (data.scope as string) || (data.workflowId ? 'workflow' : 'global');
  await db.insert(workflowVariables).values({
    id,
    name: String(data.name),
    description: (data.description as string) ?? null,
    type: String(data.type ?? 'string'),
    value: (data.value ?? null) as any,
    isSecret: data.isSecret === true,
    scope,
    workflowId: (data.workflowId as string) ?? null,
    modifiedBy: userId,
    createdAt: now,
    updatedAt: now,
  });
  return { id };
}

export async function updateVariable(
  db: Database,
  id: string,
  data: Record<string, unknown>,
  userId: string,
) {
  const [existing] = await db
    .select()
    .from(workflowVariables)
    .where(and(eq(workflowVariables.id, id), isNull(workflowVariables.deletedAt)))
    .limit(1);
  if (!existing) return null;

  const update: Record<string, unknown> = { updatedAt: new Date(), modifiedBy: userId };
  if (data.name !== undefined) update.name = data.name;
  if (data.description !== undefined) update.description = data.description;
  if (data.type !== undefined) update.type = data.type;
  if (data.value !== undefined) update.value = data.value;
  if (data.isSecret !== undefined) update.isSecret = data.isSecret;
  if (data.scope !== undefined) update.scope = data.scope;

  await db.update(workflowVariables).set(update).where(eq(workflowVariables.id, id));
  return { id };
}

export async function deleteVariable(db: Database, id: string) {
  await db
    .update(workflowVariables)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(workflowVariables.id, id), isNull(workflowVariables.deletedAt)));
}
