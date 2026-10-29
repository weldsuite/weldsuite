/**
 * `MailboxObject`'s schema migrations: from empty, idempotent re-application,
 * and forward-compatibility of the runner itself (future migrations land as
 * new `MAILBOX_MIGRATIONS` entries; this file's "from every earlier version"
 * loop already covers that — it just has one version to start from today).
 */
import { describe, expect, it } from 'vitest';
import { createSqliteDurableObjectState } from '@weldsuite/worker-kit/testing/durable-sqlite';
import { getSchemaVersion, migrateMailbox } from './migrate';
import { LATEST_MAILBOX_SCHEMA_VERSION, MAILBOX_MIGRATIONS } from './schema';

const EVERY_TABLE = [
  'meta',
  'messages',
  'message_labels',
  'message_addresses',
  'threads',
  'thread_labels',
  'label_counts',
  'attachments',
  'messages_fts_meta',
  'messages_fts_body',
  'subscriptions',
  'drafts',
  'outbox',
  'pg_drift',
];

function tableNames(storage: { sql: SqlStorage }): string[] {
  return storage.sql
    .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name")
    .toArray()
    .map((r) => r.name);
}

describe('migrateMailbox', () => {
  it('migrates a fresh object to every table at the latest version', () => {
    const { storage } = createSqliteDurableObjectState();
    migrateMailbox(storage);

    expect(getSchemaVersion(storage)).toBe(LATEST_MAILBOX_SCHEMA_VERSION);
    const names = tableNames(storage);
    for (const table of EVERY_TABLE) expect(names).toContain(table);
  });

  it('is a no-op on a second run over the same storage (idempotent, safe on every object start)', () => {
    const { storage } = createSqliteDurableObjectState();
    migrateMailbox(storage);
    const before = tableNames(storage);

    expect(() => migrateMailbox(storage)).not.toThrow();
    expect(getSchemaVersion(storage)).toBe(LATEST_MAILBOX_SCHEMA_VERSION);
    expect(tableNames(storage)).toEqual(before);
  });

  it('stamps meta.created_at exactly once, on the first migration', () => {
    const { storage } = createSqliteDurableObjectState();
    migrateMailbox(storage, 1_000);
    const first = storage.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'created_at'").toArray()[0]!.value;
    expect(first).toBe('1000');

    migrateMailbox(storage, 2_000); // a later restart must not overwrite it
    const second = storage.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'created_at'").toArray()[0]!.value;
    expect(second).toBe('1000');
  });

  it('applies every migration newer than the stored version, starting from each version in between', () => {
    // Today there is exactly one migration; this loop is written to stay
    // correct once a second one lands (`db:generate`-style forward safety).
    for (let startVersion = 0; startVersion < LATEST_MAILBOX_SCHEMA_VERSION; startVersion++) {
      const { storage } = createSqliteDurableObjectState();
      // Fast-forward to `startVersion` by applying migrations up to it directly.
      storage.sql.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID`);
      for (const migration of MAILBOX_MIGRATIONS) {
        if (migration.version > startVersion) break;
        storage.transactionSync(() => {
          for (const statement of migration.statements) storage.sql.exec(statement);
        });
      }
      storage.sql.exec(
        "INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        String(startVersion),
      );

      migrateMailbox(storage);
      expect(getSchemaVersion(storage)).toBe(LATEST_MAILBOX_SCHEMA_VERSION);
      for (const table of EVERY_TABLE) expect(tableNames(storage)).toContain(table);
    }
  });

  it('FTS5 tables accept the two configurations the design calls for (trigram meta, unicode61 body)', () => {
    const { storage } = createSqliteDurableObjectState();
    migrateMailbox(storage);
    storage.sql.exec("INSERT INTO messages_fts_meta (rowid, subject, sender, recipients) VALUES (1, 'Your invoice', 'Billing billing@acme.com', 'me@x.com')");
    expect(storage.sql.exec("SELECT rowid FROM messages_fts_meta WHERE messages_fts_meta MATCH 'voice'").toArray()).toEqual([
      { rowid: 1 },
    ]);

    storage.sql.exec("INSERT INTO messages_fts_body (rowid, body) VALUES (1, 'café invoice')");
    expect(storage.sql.exec("SELECT rowid FROM messages_fts_body WHERE messages_fts_body MATCH 'cafe*'").toArray()).toEqual([
      { rowid: 1 },
    ]);

    storage.sql.exec('DELETE FROM messages_fts_meta WHERE rowid = 1');
    storage.sql.exec('DELETE FROM messages_fts_body WHERE rowid = 1');
    expect(storage.sql.exec("SELECT rowid FROM messages_fts_meta WHERE messages_fts_meta MATCH 'voice'").toArray()).toEqual([]);
    expect(storage.sql.exec("SELECT rowid FROM messages_fts_body WHERE messages_fts_body MATCH 'cafe*'").toArray()).toEqual([]);
  });

  it('messages.idempotency_key is unique only among non-null values', () => {
    const { storage } = createSqliteDurableObjectState();
    migrateMailbox(storage);
    const insert = (id: string, key: string | null) =>
      storage.sql.exec(
        `INSERT INTO messages (id, rfc_message_id, thread_key, from_json, to_json, sent_at, sort_at, labels_json, created_at, updated_at, idempotency_key)
         VALUES (?, 'rfc', ?, '{}', '[]', 0, 0, '[]', 0, 0, ?)`,
        id,
        id,
        key,
      );
    insert('m1', null);
    insert('m2', null); // two NULLs must coexist
    insert('m3', 'uniq-1');
    expect(() => insert('m4', 'uniq-1')).toThrow();
  });
});
