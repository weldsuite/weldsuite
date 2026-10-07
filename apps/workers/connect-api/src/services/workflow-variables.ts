/**
 * Workflow variables service — CRUD plus the two "scope" queries the editor
 * needs (`/global`, `/workflow/:workflowId`). Secrets are masked in the
 * response payload; the raw value is never returned to the client.
 */

import { and, desc, eq, isNull, like, lt, or, sql } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';

const { workflowVariables, workflows } = schema;

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
      // Ordered by id (time-prefixed, so newest first) to match the `lt(id)`
      // cursor; ordering by updatedAt skipped and repeated rows across pages.
      .orderBy(desc(workflowVariables.id))
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

/**
 * The scope a create request resolves to. The engine treats a variable with no
 * `workflowId` as global (apps/workers/workflow-worker/src/index.ts), so
 * `workflow` scope needs one and `global` scope must not carry one.
 */
export function resolveVariableScope(data: {
  scope?: string;
  isGlobal?: boolean;
  workflowId?: string | null;
}): { scope: 'global' | 'workflow'; workflowId: string | null } | null {
  const scope = data.scope ?? (data.isGlobal === true ? 'global' : data.workflowId ? 'workflow' : 'global');
  if (scope === 'global') return { scope: 'global', workflowId: null };
  if (scope === 'workflow' && data.workflowId) return { scope: 'workflow', workflowId: data.workflowId };
  return null;
}

/**
 * A variable a workflow run would see under the same name: the engine merges
 * a workflow's own variables with every global into one map, so a clash
 * leaves the value that wins down to row order. A global name must be unique
 * workspace-wide; a workflow variable must not clash with a global or with
 * another variable of the same workflow.
 */
export async function findConflictingVariable(
  db: Database,
  name: string,
  target: { scope: 'global' | 'workflow'; workflowId: string | null },
) {
  const nameMatch = and(eq(workflowVariables.name, name), isNull(workflowVariables.deletedAt));
  const where =
    target.scope === 'global' || !target.workflowId
      ? nameMatch
      : and(
          nameMatch,
          or(isNull(workflowVariables.workflowId), eq(workflowVariables.workflowId, target.workflowId)),
        );
  const [row] = await db
    .select({ id: workflowVariables.id })
    .from(workflowVariables)
    .where(where)
    .limit(1);
  return row ?? null;
}

export async function workflowExists(db: Database, workflowId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: workflows.id })
    .from(workflows)
    .where(and(eq(workflows.id, workflowId), isNull(workflows.deletedAt)))
    .limit(1);
  return !!row;
}

export async function createVariable(db: Database, data: Record<string, unknown>, userId: string) {
  const id = generateId('var');
  const now = new Date();
  const resolved = resolveVariableScope({
    scope: data.scope as string | undefined,
    isGlobal: data.isGlobal === true,
    workflowId: (data.workflowId as string | null | undefined) ?? null,
  });
  const scope = resolved?.scope ?? 'global';
  await db.insert(workflowVariables).values({
    id,
    name: String(data.name),
    description: (data.description as string) ?? null,
    type: String(data.type ?? 'string'),
    value: (data.value ?? null) as any,
    isSecret: data.isSecret === true,
    scope,
    workflowId: resolved?.workflowId ?? null,
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
