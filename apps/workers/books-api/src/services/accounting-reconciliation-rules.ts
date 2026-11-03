/**
 * Reconciliation rules: "a line whose description contains 'huur' goes to
 * 4210 Huur". A rule has conditions on the bank line (all or any must hold)
 * and a category account to post the line to.
 *
 * Text conditions compare case-insensitively and ignore surrounding spaces;
 * amount conditions compare the absolute amount, so a rule reads the same for
 * money in and money out. Rules are tried highest priority first, and the
 * first one that matches wins.
 */

import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { schema as tables, type Database } from '@weldsuite/worker-kit/db';
import type { MatchableTransaction } from './accounting-reconciliation';

export type ReconciliationRuleRow = typeof tables.reconciliationRules.$inferSelect;
type RuleCondition = NonNullable<ReconciliationRuleRow['conditions']>[number];

/** Active rules of an entity, highest priority first, that can post a line (they name a category account). */
export async function loadActiveRules(db: Database, entityId: string): Promise<ReconciliationRuleRow[]> {
  const t = tables.reconciliationRules;
  const rows = await db
    .select()
    .from(t)
    .where(and(eq(t.entityId, entityId), eq(t.isActive, true), isNull(t.deletedAt)))
    .orderBy(desc(t.priority), t.createdAt);
  return rows.filter((r) => Boolean(r.actions?.categoryAccountId) && (r.conditions?.length ?? 0) > 0);
}

function fieldText(txn: MatchableTransaction, field: RuleCondition['field']): string {
  switch (field) {
    case 'description':
      return txn.description ?? '';
    case 'counterpartyName':
      return txn.counterpartyName ?? '';
    case 'counterpartyIban':
      // An IBAN reads the same with or without its spaces.
      return (txn.counterpartyIban ?? '').replaceAll(/\s/g, '');
    case 'reference':
      return txn.reference ?? '';
    default:
      return '';
  }
}

function toNumber(value: string | number | undefined): number {
  return typeof value === 'number' ? value : Number.parseFloat(String(value ?? '').replace(',', '.'));
}

/** Whether one condition holds for a bank line. */
export function conditionMatches(txn: MatchableTransaction, cond: RuleCondition): boolean {
  if (cond.field === 'amount') {
    const amount = Math.abs(Number.parseFloat(txn.amount || '0'));
    const value = toNumber(cond.value);
    if (!Number.isFinite(amount) || !Number.isFinite(value)) return false;
    switch (cond.operator) {
      case 'equals':
        return Math.abs(amount - value) < 0.005;
      case 'greater_than':
        return amount > value;
      case 'less_than':
        return amount < value;
      case 'between': {
        const upper = toNumber(cond.value2);
        if (!Number.isFinite(upper)) return false;
        return amount >= Math.min(value, upper) && amount <= Math.max(value, upper);
      }
      default:
        return false;
    }
  }

  const needleRaw = String(cond.value ?? '').trim().toLowerCase();
  const needle = cond.field === 'counterpartyIban' ? needleRaw.replaceAll(/\s/g, '') : needleRaw;
  if (!needle) return false;
  const text = fieldText(txn, cond.field).trim().toLowerCase();
  switch (cond.operator) {
    case 'contains':
      return text.includes(needle);
    case 'equals':
      return text === needle;
    case 'starts_with':
      return text.startsWith(needle);
    case 'ends_with':
      return text.endsWith(needle);
    default:
      return false;
  }
}

/** Whether a rule matches a bank line: every condition (`all`, the default) or at least one (`any`). */
export function ruleMatches(txn: MatchableTransaction, rule: Pick<ReconciliationRuleRow, 'conditions' | 'matchMode'>): boolean {
  const conditions = rule.conditions ?? [];
  if (conditions.length === 0) return false;
  return rule.matchMode === 'any'
    ? conditions.some((cond) => conditionMatches(txn, cond))
    : conditions.every((cond) => conditionMatches(txn, cond));
}

/** The first rule (rules come highest priority first) that matches the line. */
export function findMatchingRule(
  txn: MatchableTransaction,
  rules: readonly ReconciliationRuleRow[],
): ReconciliationRuleRow | undefined {
  return rules.find((rule) => ruleMatches(txn, rule));
}

/** Count a rule's use: `matchCount` and `lastMatchedAt` show on the Rules page. */
export async function recordRuleMatch(db: Database, ruleId: string): Promise<void> {
  const t = tables.reconciliationRules;
  const now = new Date();
  await db
    .update(t)
    .set({ matchCount: sql`coalesce(${t.matchCount}, 0) + 1`, lastMatchedAt: now })
    .where(eq(t.id, ruleId));
}
