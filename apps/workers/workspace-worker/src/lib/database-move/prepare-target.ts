/**
 * Target preparation: make a freshly provisioned (and migrated) database ready
 * to receive a bulk copy.
 *
 *  - journal check: source and target must sit at the same migration;
 *  - TRUNCATE every user table (warm-pool targets are pre-seeded);
 *  - DROP every foreign key (the copy inserts tables in size order, and the
 *    keys are re-added and validated afterwards, which doubles as the
 *    integrity check);
 *  - DISABLE TRIGGER USER where user triggers exist, so copied rows do not
 *    fire the application's side effects a second time.
 *
 * All of it runs as ONE transaction (one subrequest), so a failure leaves the
 * target as it was, and re-running after success is harmless: dropping a
 * constraint that is already gone and disabling an already-disabled trigger are
 * no-ops. Do not re-run it once copying has started: it truncates.
 */

import { readForeignKeys, readJournalSummary, readTables, readTriggers } from './catalog';
import { JournalMismatchError, SchemaMismatchError, UnsupportedSchemaError } from './errors';
import { qualifiedTable, quoteIdent } from './quote';
import type { Catalog, ForeignKeyInfo, JournalSummary, SavedTargetState, SqlStatement, TenantSql, TriggerInfo } from './types';

export interface PrepareTargetResult {
  /** Pass this to `finishTarget`; persist it with the Workflow state. */
  saved: SavedTargetState;
  truncatedTables: number;
  droppedForeignKeys: number;
  /** Tables that had user triggers disabled. */
  triggerTables: number;
  /** Tables present on the target but not on the source (truncated too, never copied). */
  extraTargetTables: string[];
}

/** Fail fast when a lock cannot be taken; the target has no traffic, so any wait means something unexpected holds it. */
const LOCK_TIMEOUT_STATEMENT: SqlStatement = { text: `SET LOCAL lock_timeout = '30s'` };

export function journalsMatch(source: JournalSummary | null, target: JournalSummary | null): boolean {
  if (!source || !target) return false;
  return source.count === target.count && source.maxCreatedAt === target.maxCreatedAt;
}

/** Refuse a schema the engine cannot copy faithfully. Throws {@link UnsupportedSchemaError}. */
export function assertCopySupported(catalog: Pick<Catalog, 'sequences'>): void {
  if (catalog.sequences.length > 0) throw new UnsupportedSchemaError('sequences', catalog.sequences);
}

function mergeForeignKeys(source: readonly ForeignKeyInfo[], target: readonly ForeignKeyInfo[]): ForeignKeyInfo[] {
  const merged = new Map<string, ForeignKeyInfo>();
  const key = (fk: ForeignKeyInfo): string => `${fk.table}\u0000${fk.name}`;
  // Source first: it is the definition of record, and after a first prepare the target no longer has the keys at all.
  for (const fk of source) merged.set(key(fk), fk);
  for (const fk of target) if (!merged.has(key(fk))) merged.set(key(fk), fk);
  return [...merged.values()];
}

/**
 * @param targetSql connection to the target database
 * @param catalog the SOURCE catalog (`readCatalog(sourceSql)`), the definition of what the target must end up as
 */
export async function prepareTargetForCopy(targetSql: TenantSql, catalog: Catalog): Promise<PrepareTargetResult> {
  assertCopySupported(catalog);

  const targetJournal = await readJournalSummary(targetSql);
  if (!journalsMatch(catalog.journal, targetJournal)) throw new JournalMismatchError(catalog.journal, targetJournal);

  const targetTables = await readTables(targetSql);
  const targetByName = new Map(targetTables.map((t) => [t.name, t]));
  const missingTables: string[] = [];
  const missingColumns: Array<{ table: string; column: string }> = [];
  for (const table of catalog.tables) {
    const onTarget = targetByName.get(table.name);
    if (!onTarget) {
      missingTables.push(table.name);
      continue;
    }
    const have = new Set(onTarget.columns.map((c) => c.name));
    for (const column of table.columns) {
      if (!have.has(column.name)) missingColumns.push({ table: table.name, column: column.name });
    }
  }
  if (missingTables.length > 0 || missingColumns.length > 0) throw new SchemaMismatchError(missingTables, missingColumns);

  const sourceNames = new Set(catalog.tables.map((t) => t.name));
  const extraTargetTables = targetTables.map((t) => t.name).filter((name) => !sourceNames.has(name));

  const foreignKeys = mergeForeignKeys(catalog.foreignKeys, await readForeignKeys(targetSql));
  // Source triggers carry the original mode. A target-only trigger cannot exist when the journals match;
  // if one does, assume the default mode so it is switched back on at the end.
  const triggers: TriggerInfo[] = [...catalog.triggers];
  const triggerTables = new Set(triggers.map((t) => t.table));
  const targetTriggers = await readTriggers(targetSql);
  for (const trigger of targetTriggers) {
    if (!triggers.some((t) => t.table === trigger.table && t.name === trigger.name)) {
      triggers.push({ ...trigger, enabled: 'O' });
      triggerTables.add(trigger.table);
    }
  }

  const statements: SqlStatement[] = [LOCK_TIMEOUT_STATEMENT];
  for (const fk of foreignKeys) {
    statements.push({
      text: `ALTER TABLE IF EXISTS ${qualifiedTable(fk.table)} DROP CONSTRAINT IF EXISTS ${quoteIdent(fk.name)}`,
    });
  }
  // One explicit list: TRUNCATE accepts tables that reference each other when all of them are named together.
  if (targetTables.length > 0) {
    statements.push({ text: `TRUNCATE TABLE ${targetTables.map((t) => qualifiedTable(t.name)).join(', ')}` });
  }
  for (const table of triggerTables) {
    statements.push({ text: `ALTER TABLE IF EXISTS ${qualifiedTable(table)} DISABLE TRIGGER USER` });
  }
  await targetSql.transaction(statements);

  return {
    saved: { foreignKeys, triggers },
    truncatedTables: targetTables.length,
    droppedForeignKeys: foreignKeys.length,
    triggerTables: triggerTables.size,
    extraTargetTables,
  };
}
