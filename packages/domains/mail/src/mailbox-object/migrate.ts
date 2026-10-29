/**
 * `MailboxObject`'s migration runner (design §3.4). Mirrors
 * `mail-index/mail-index.ts`'s `migrate()` exactly: bootstrap `meta` with
 * `IF NOT EXISTS`, read `schema_version`, then apply every migration newer
 * than that, each in its own `transactionSync`, recording the new version at
 * the end of that same transaction so a crash mid-migration never leaves
 * `schema_version` ahead of the tables it names.
 *
 * Safe to call on every object start (constructor-time, inside
 * `ctx.blockConcurrencyWhile`, task C1): a fully migrated object just reads
 * `schema_version` and returns without writing anything.
 */

import { MAILBOX_MIGRATIONS } from './schema';

/** The subset of `DurableObjectStorage` migration needs — easy to hand a plain `{sql}` in a test. */
export interface MigratableStorage {
  sql: SqlStorage;
  transactionSync<T>(closure: () => T): T;
}

function getMetaValue(storage: MigratableStorage, key: string): string | null {
  const row = storage.sql.exec<{ value: string }>('SELECT value FROM meta WHERE key = ?', key).toArray()[0];
  return row ? row.value : null;
}

function setMetaValue(storage: MigratableStorage, key: string, value: string): void {
  storage.sql.exec(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    key,
    value,
  );
}

/** `meta.schema_version`, or 0 for a never-migrated (freshly created) object. */
export function getSchemaVersion(storage: MigratableStorage): number {
  storage.sql.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID`);
  const raw = getMetaValue(storage, 'schema_version');
  return raw === null ? 0 : Number(raw);
}

/**
 * Applies every `MAILBOX_MIGRATIONS` entry newer than the stored
 * `schema_version`, oldest first, each inside its own `transactionSync`. Also
 * stamps `meta.created_at` the first time the object is migrated (design
 * §3.1's `meta` key list), since that only makes sense to set once, not on
 * every migration step.
 */
export function migrateMailbox(storage: MigratableStorage, now: number = Date.now()): void {
  let current = getSchemaVersion(storage);
  const isFirstRun = current === 0;

  for (const migration of MAILBOX_MIGRATIONS) {
    if (migration.version <= current) continue;
    storage.transactionSync(() => {
      for (const statement of migration.statements) storage.sql.exec(statement);
      setMetaValue(storage, 'schema_version', String(migration.version));
    });
    current = migration.version;
  }

  if (isFirstRun && current > 0 && getMetaValue(storage, 'created_at') === null) {
    setMetaValue(storage, 'created_at', String(now));
  }
}
