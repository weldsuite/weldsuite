/**
 * Mail rule service.
 *
 * Rules are JSONB-encoded condition/action bundles per account. The
 * rule engine that actually evaluates them on inbound mail lives in the
 * mail-inbound-worker; this surface only manages the records.
 *
 * Ordering: `priority` is the engine's sort key (lower first). The
 * `reorder` op takes an explicit list of `(id, priority)` pairs and
 * applies them in a single UPDATE — no SELECT first since we're
 * trusting the caller's payload to be the new canonical order.
 */

import { and, asc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { schema } from '../../db';
import type { Database } from '../../db';
import { generateId } from '../../lib/id';
import type {
  MailRuleAction,
  MailRuleCondition,
} from '@weldsuite/db/schema/mail-rules';

const { mailRules } = schema;

export class MailRuleError extends Error {
  constructor(public readonly code: 'NOT_FOUND', message: string) {
    super(message);
    this.name = 'MailRuleError';
  }
}

export interface ListRulesFilters {
  accountId?: string;
  isActive?: boolean;
}

export async function listRules(db: Database, filters: ListRulesFilters) {
  const conditions: SQL[] = [isNull(mailRules.deletedAt)!];
  if (filters.accountId) conditions.push(eq(mailRules.accountId, filters.accountId));
  if (filters.isActive !== undefined) conditions.push(eq(mailRules.isActive, filters.isActive));
  return db
    .select()
    .from(mailRules)
    .where(and(...conditions))
    .orderBy(asc(mailRules.priority), asc(mailRules.createdAt));
}

export async function getRule(db: Database, id: string) {
  const [row] = await db
    .select()
    .from(mailRules)
    .where(and(eq(mailRules.id, id), isNull(mailRules.deletedAt)))
    .limit(1);
  return row ?? null;
}

export interface RuleInput {
  accountId: string;
  name: string;
  description?: string;
  conditions: MailRuleCondition[];
  matchType?: 'all' | 'any';
  actions: MailRuleAction[];
  isActive?: boolean;
  stopProcessing?: boolean;
  priority?: number;
  applyToExisting?: boolean;
  scope?: 'incoming' | 'outgoing' | 'all';
  folders?: string[];
}

export async function createRule(db: Database, data: RuleInput) {
  const id = generateId('rule');
  const now = new Date();
  await db.insert(mailRules).values({
    id,
    accountId: data.accountId,
    name: data.name,
    description: data.description,
    conditions: data.conditions,
    matchType: data.matchType ?? 'all',
    actions: data.actions,
    isActive: data.isActive ?? true,
    stopProcessing: data.stopProcessing ?? false,
    priority: data.priority ?? 0,
    applyToExisting: data.applyToExisting ?? false,
    scope: data.scope ?? 'incoming',
    folders: data.folders,
    createdAt: now,
    updatedAt: now,
  });
  const [row] = await db.select().from(mailRules).where(eq(mailRules.id, id));
  return row!;
}

export async function updateRule(db: Database, id: string, data: Partial<RuleInput>) {
  const [existing] = await db
    .select()
    .from(mailRules)
    .where(and(eq(mailRules.id, id), isNull(mailRules.deletedAt)))
    .limit(1);
  if (!existing) throw new MailRuleError('NOT_FOUND', 'Rule not found');
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  for (const [k, v] of Object.entries(data)) if (v !== undefined) patch[k] = v;
  await db
    .update(mailRules)
    .set(patch as typeof mailRules.$inferInsert)
    .where(eq(mailRules.id, id));
  const [after] = await db.select().from(mailRules).where(eq(mailRules.id, id));
  return { before: existing, after: after! };
}

export async function softDeleteRule(db: Database, id: string) {
  const [existing] = await db
    .select()
    .from(mailRules)
    .where(and(eq(mailRules.id, id), isNull(mailRules.deletedAt)))
    .limit(1);
  if (!existing) return null;
  await db
    .update(mailRules)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(mailRules.id, id));
  return existing;
}

export async function toggleRule(db: Database, id: string) {
  const [existing] = await db
    .select({ isActive: mailRules.isActive })
    .from(mailRules)
    .where(and(eq(mailRules.id, id), isNull(mailRules.deletedAt)))
    .limit(1);
  if (!existing) throw new MailRuleError('NOT_FOUND', 'Rule not found');
  const next = !existing.isActive;
  await db
    .update(mailRules)
    .set({ isActive: next, updatedAt: new Date() })
    .where(eq(mailRules.id, id));
  const [after] = await db.select().from(mailRules).where(eq(mailRules.id, id));
  return after!;
}

export async function duplicateRule(db: Database, id: string) {
  const source = await getRule(db, id);
  if (!source) throw new MailRuleError('NOT_FOUND', 'Rule not found');
  const newId = generateId('rule');
  const now = new Date();
  await db.insert(mailRules).values({
    id: newId,
    accountId: source.accountId,
    name: `${source.name} (Copy)`,
    description: source.description,
    conditions: source.conditions,
    matchType: source.matchType,
    actions: source.actions,
    isActive: false, // Duplicates start disabled so they don't double-fire.
    stopProcessing: source.stopProcessing,
    priority: source.priority,
    applyToExisting: false,
    scope: source.scope,
    folders: source.folders,
    createdAt: now,
    updatedAt: now,
  });
  const [row] = await db.select().from(mailRules).where(eq(mailRules.id, newId));
  return row!;
}

/**
 * Apply a new priority to each rule in the supplied order. The list IS
 * the canonical ordering — index becomes priority. Single UPDATE with a
 * CASE expression so we don't round-trip per row.
 */
export async function reorderRules(
  db: Database,
  ordered: { id: string; priority: number }[],
): Promise<{ updated: number }> {
  if (ordered.length === 0) return { updated: 0 };
  const ids = ordered.map((o) => o.id);
  const caseClauses = ordered
    .map((o) => sql`WHEN ${mailRules.id} = ${o.id} THEN ${o.priority}`)
    .reduce((acc, frag) => sql`${acc} ${frag}`, sql``);
  const result = await db
    .update(mailRules)
    .set({
      priority: sql`CASE ${caseClauses} ELSE ${mailRules.priority} END`,
      updatedAt: new Date(),
    })
    .where(and(inArray(mailRules.id, ids), isNull(mailRules.deletedAt)))
    .returning({ id: mailRules.id });
  return { updated: result.length };
}
