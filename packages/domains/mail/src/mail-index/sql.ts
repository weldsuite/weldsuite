/**
 * `MailIndex`'s schema: versioned, append-only migrations applied through
 * `ctx.storage.sql`, one `transactionSync` per version (mirrors the pattern
 * `docs/plans/weldmail-mailbox-store-design.md` §3.4 describes for
 * `MailboxObject`). Each array entry is one statement; `MailIndex`'s
 * constructor runs every migration newer than the stored `schema_version`.
 */

export interface MailIndexMigration {
  version: number;
  statements: readonly string[];
}

export const MAIL_INDEX_MIGRATIONS: readonly MailIndexMigration[] = [
  {
    version: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) WITHOUT ROWID`,
      // Everyone the workspace exchanged mail with, one row per lower-cased
      // address. Mirrors tenant Postgres `mail_correspondents`
      // (packages/core/db/src/schema/mail-correspondents.ts): timestamps are
      // epoch-ms integers here instead of `timestamp`.
      `CREATE TABLE correspondents (
        email TEXT PRIMARY KEY,
        first_inbound_at INTEGER,
        last_inbound_at INTEGER,
        inbound_count INTEGER NOT NULL DEFAULT 0,
        first_outbound_at INTEGER,
        last_outbound_at INTEGER,
        outbound_count INTEGER NOT NULL DEFAULT 0,
        replied_after_first_contact INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      ) WITHOUT ROWID`,
      // Which mailbox(es) an address has touched, for `mailboxesForAddress`
      // (the CRM Emails tab fan-out, §5) and for workspace mail deletion
      // (`dropMailbox`).
      `CREATE TABLE address_index (
        address TEXT NOT NULL,
        account_id TEXT NOT NULL,
        last_seen_at INTEGER NOT NULL,
        message_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (address, account_id)
      ) WITHOUT ROWID`,
      `CREATE INDEX address_index_address_idx ON address_index(address, last_seen_at DESC)`,
      // Idempotency for `recordMailAddresses`: a mailbox's outbox retries a
      // batch after a partial failure, so every entry is applied at most once
      // per message id.
      `CREATE TABLE applied_messages (
        message_id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      ) WITHOUT ROWID`,
      `CREATE INDEX applied_messages_applied_at_idx ON applied_messages(applied_at)`,
    ],
  },
];

/**
 * Inbound event upsert: ports `mail_correspondents_track_inbound()`
 * (packages/core/db/drizzle/tenant-migrations/0214_outbound_mail_guard.sql)
 * statement-for-statement. Outbound columns are never touched here, matching
 * the trigger (it only sets the inbound columns and `replied_after_first_contact`).
 * `replied_after_first_contact` reads the *pre*-update row (SQLite's bare
 * column reference in `ON CONFLICT ... DO UPDATE SET`, like Postgres', is the
 * existing row; `excluded.*` is the proposed one).
 */
export const UPSERT_INBOUND_CORRESPONDENT = `
  INSERT INTO correspondents (email, first_inbound_at, last_inbound_at, inbound_count, updated_at)
  VALUES (?, ?, ?, 1, ?)
  ON CONFLICT(email) DO UPDATE SET
    first_inbound_at = CASE
      WHEN correspondents.first_inbound_at IS NULL THEN excluded.first_inbound_at
      ELSE MIN(correspondents.first_inbound_at, excluded.first_inbound_at)
    END,
    last_inbound_at = CASE
      WHEN correspondents.last_inbound_at IS NULL THEN excluded.last_inbound_at
      ELSE MAX(correspondents.last_inbound_at, excluded.last_inbound_at)
    END,
    inbound_count = correspondents.inbound_count + 1,
    replied_after_first_contact = correspondents.replied_after_first_contact OR
      (correspondents.first_outbound_at IS NOT NULL AND
        (correspondents.first_inbound_at IS NULL OR correspondents.first_inbound_at > correspondents.first_outbound_at)),
    updated_at = excluded.updated_at
`;

/**
 * Outbound event upsert: ports `recordOutboundCorrespondents`
 * (outbound/correspondents.ts) statement-for-statement.
 * `replied_after_first_contact` is never touched here either, matching that
 * function exactly (only the one-time Postgres backfill sets it from an
 * outbound row; steady state only changes it on inbound).
 */
export const UPSERT_OUTBOUND_CORRESPONDENT = `
  INSERT INTO correspondents (email, first_outbound_at, last_outbound_at, outbound_count, updated_at)
  VALUES (?, ?, ?, 1, ?)
  ON CONFLICT(email) DO UPDATE SET
    first_outbound_at = COALESCE(correspondents.first_outbound_at, excluded.first_outbound_at),
    last_outbound_at = excluded.last_outbound_at,
    outbound_count = correspondents.outbound_count + 1,
    updated_at = excluded.updated_at
`;

/**
 * Bulk merge used only while applying a seed page from Postgres (`alarm()`'s
 * seeding step). Unlike the two event upserts above, counts are merged with
 * `MAX` rather than incremented: the incoming row is a Postgres snapshot
 * (an absolute total as of when that page was read), and live events may have
 * already bumped this row past it while the seed was still running. Taking
 * the max avoids both undercounting (losing live increments) and
 * double-counting (summing a live increment into the snapshot's own total).
 */
export const UPSERT_SEED_CORRESPONDENT = `
  INSERT INTO correspondents (
    email, first_inbound_at, last_inbound_at, inbound_count,
    first_outbound_at, last_outbound_at, outbound_count,
    replied_after_first_contact, updated_at
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(email) DO UPDATE SET
    first_inbound_at = CASE
      WHEN correspondents.first_inbound_at IS NULL THEN excluded.first_inbound_at
      WHEN excluded.first_inbound_at IS NULL THEN correspondents.first_inbound_at
      ELSE MIN(correspondents.first_inbound_at, excluded.first_inbound_at)
    END,
    last_inbound_at = CASE
      WHEN correspondents.last_inbound_at IS NULL THEN excluded.last_inbound_at
      WHEN excluded.last_inbound_at IS NULL THEN correspondents.last_inbound_at
      ELSE MAX(correspondents.last_inbound_at, excluded.last_inbound_at)
    END,
    inbound_count = MAX(correspondents.inbound_count, excluded.inbound_count),
    first_outbound_at = CASE
      WHEN correspondents.first_outbound_at IS NULL THEN excluded.first_outbound_at
      WHEN excluded.first_outbound_at IS NULL THEN correspondents.first_outbound_at
      ELSE MIN(correspondents.first_outbound_at, excluded.first_outbound_at)
    END,
    last_outbound_at = CASE
      WHEN correspondents.last_outbound_at IS NULL THEN excluded.last_outbound_at
      WHEN excluded.last_outbound_at IS NULL THEN correspondents.last_outbound_at
      ELSE MAX(correspondents.last_outbound_at, excluded.last_outbound_at)
    END,
    outbound_count = MAX(correspondents.outbound_count, excluded.outbound_count),
    replied_after_first_contact = correspondents.replied_after_first_contact OR excluded.replied_after_first_contact,
    updated_at = MAX(correspondents.updated_at, excluded.updated_at)
`;

export const UPSERT_ADDRESS_INDEX = `
  INSERT INTO address_index (address, account_id, last_seen_at, message_count)
  VALUES (?, ?, ?, 1)
  ON CONFLICT(address, account_id) DO UPDATE SET
    last_seen_at = MAX(address_index.last_seen_at, excluded.last_seen_at),
    message_count = address_index.message_count + 1
`;
