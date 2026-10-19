/**
 * Target finishing: undo what `prepareTargetForCopy` did, in an order that
 * doubles as the integrity check.
 *
 *  1. re-enable the user triggers (each in the mode it had on the source; a
 *     trigger that was disabled on the source stays disabled);
 *  2. re-add every foreign key `NOT VALID`, then `VALIDATE CONSTRAINT`. A key
 *     the copied data violates throws {@link ForeignKeyValidationError} naming
 *     the constraint, and that key stays absent (its add and validate share one
 *     transaction), so the target is never left with an unchecked key;
 *  3. refresh the materialized views that were populated on the source and
 *     empty the ones that were not (a pooled target may have refreshed one
 *     against its seed rows).
 *
 * Every step is idempotent: it looks at what the target has now and only does
 * what is missing. `finishTarget` can take a while on large databases (each
 * validation scans a whole table), so it accepts `maxForeignKeys` and reports
 * `complete: false` with the number still pending; call it again in the next
 * Workflow step until `complete` is true.
 */

import { readForeignKeys, readMaterializedViews } from './catalog';
import { ForeignKeyValidationError } from './errors';
import { qualifiedTable, quoteIdent } from './quote';
import type { Catalog, ForeignKeyInfo, SavedTargetState, SqlStatement, TenantSql, TriggerInfo } from './types';

/** SQLSTATE foreign_key_violation. */
const FOREIGN_KEY_VIOLATION = '23503';

function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    return typeof error.code === 'string' ? error.code : undefined;
  }
  return undefined;
}

const enableClause: Record<Exclude<TriggerInfo['enabled'], 'D'>, string> = {
  O: 'ENABLE TRIGGER',
  R: 'ENABLE REPLICA TRIGGER',
  A: 'ENABLE ALWAYS TRIGGER',
};

/** Put every disabled user trigger back to the mode it had on the source. One transaction. Returns how many were enabled. */
export async function restoreTriggers(targetSql: TenantSql, saved: Pick<SavedTargetState, 'triggers'>): Promise<number> {
  const statements: SqlStatement[] = [];
  for (const trigger of saved.triggers) {
    if (trigger.enabled === 'D') continue; // disabled on the source, stays disabled
    statements.push({
      text: `ALTER TABLE ${qualifiedTable(trigger.table)} ${enableClause[trigger.enabled]} ${quoteIdent(trigger.name)}`,
    });
  }
  if (statements.length > 0) await targetSql.transaction(statements);
  return statements.length;
}

export interface RestoreForeignKeysOptions {
  /** Add/validate at most this many keys in this call (one subrequest each). Defaults to all. */
  limit?: number;
}

export interface RestoreForeignKeysResult {
  /** Keys added and/or validated by this call. */
  restored: number;
  /** Keys still to do after this call; 0 means every saved key is in place and validated. */
  remaining: number;
}

function stripNotValid(definition: string): string {
  return definition.replace(/\s+NOT VALID\s*$/i, '');
}

/** Re-add and validate the saved foreign keys, skipping those already in place. */
export async function restoreForeignKeys(
  targetSql: TenantSql,
  saved: Pick<SavedTargetState, 'foreignKeys'>,
  options: RestoreForeignKeysOptions = {},
): Promise<RestoreForeignKeysResult> {
  const current = await readForeignKeys(targetSql);
  const state = new Map(current.map((fk) => [`${fk.table}\u0000${fk.name}`, fk.validated]));
  const limit = options.limit ?? Number.POSITIVE_INFINITY;

  const pending: Array<{ fk: ForeignKeyInfo; statements: SqlStatement[] }> = [];
  for (const fk of saved.foreignKeys) {
    const present = state.get(`${fk.table}\u0000${fk.name}`);
    const table = qualifiedTable(fk.table);
    const name = quoteIdent(fk.name);
    const statements: SqlStatement[] = [];
    if (present === undefined) {
      statements.push({ text: `ALTER TABLE ${table} ADD CONSTRAINT ${name} ${stripNotValid(fk.definition)} NOT VALID` });
    }
    // A key that was NOT VALID on the source stays that way: validating would fail on rows the source already had.
    if (fk.validated && present !== true) statements.push({ text: `ALTER TABLE ${table} VALIDATE CONSTRAINT ${name}` });
    if (statements.length > 0) pending.push({ fk, statements });
  }

  let restored = 0;
  for (const { fk, statements } of pending) {
    if (restored >= limit) break;
    try {
      await targetSql.transaction(statements);
    } catch (error) {
      if (errorCode(error) === FOREIGN_KEY_VIOLATION) throw new ForeignKeyValidationError(fk.table, fk.name, error);
      throw error;
    }
    restored += 1;
  }
  return { restored, remaining: pending.length - restored };
}

export interface RefreshViewsResult {
  /** Views refreshed (populated on the source). */
  refreshed: string[];
  /** Views emptied with `WITH NO DATA` (not populated on the source, but populated on the target). */
  cleared: string[];
}

/** Make each materialized view's populated state match the source. */
export async function refreshMaterializedViews(
  targetSql: TenantSql,
  catalog: Pick<Catalog, 'materializedViews'>,
): Promise<RefreshViewsResult> {
  const onTarget = new Map((await readMaterializedViews(targetSql)).map((v) => [v.name, v.populated]));
  const result: RefreshViewsResult = { refreshed: [], cleared: [] };
  for (const view of catalog.materializedViews) {
    if (view.populated) {
      await targetSql.query(`REFRESH MATERIALIZED VIEW ${qualifiedTable(view.name)}`);
      result.refreshed.push(view.name);
    } else if (onTarget.get(view.name) === true) {
      await targetSql.query(`REFRESH MATERIALIZED VIEW ${qualifiedTable(view.name)} WITH NO DATA`);
      result.cleared.push(view.name);
    }
  }
  return result;
}

export interface FinishTargetOptions {
  /** Cap on foreign keys restored per call; see {@link RestoreForeignKeysOptions.limit}. */
  maxForeignKeys?: number;
}

export interface FinishTargetResult {
  restoredTriggers: number;
  restoredForeignKeys: number;
  remainingForeignKeys: number;
  refreshedViews: string[];
  clearedViews: string[];
  /** True when every phase ran to the end. When false, call `finishTarget` again with the same arguments. */
  complete: boolean;
}

/**
 * @param saved `PrepareTargetResult.saved`
 * @param catalog the SOURCE catalog (for the materialized views' populated flags)
 */
export async function finishTarget(
  targetSql: TenantSql,
  saved: SavedTargetState,
  catalog: Pick<Catalog, 'materializedViews'>,
  options: FinishTargetOptions = {},
): Promise<FinishTargetResult> {
  const restoredTriggers = await restoreTriggers(targetSql, saved);
  const keys = await restoreForeignKeys(targetSql, saved, { limit: options.maxForeignKeys });
  if (keys.remaining > 0) {
    return {
      restoredTriggers,
      restoredForeignKeys: keys.restored,
      remainingForeignKeys: keys.remaining,
      refreshedViews: [],
      clearedViews: [],
      complete: false,
    };
  }
  const views = await refreshMaterializedViews(targetSql, catalog);
  return {
    restoredTriggers,
    restoredForeignKeys: keys.restored,
    remainingForeignKeys: 0,
    refreshedViews: views.refreshed,
    clearedViews: views.cleared,
    complete: true,
  };
}
