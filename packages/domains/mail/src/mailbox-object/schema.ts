/**
 * `MailboxObject`'s SQLite DDL (design §3.1, with the Decisions block at the
 * top of docs/plans/weldmail-mailbox-store-design.md overriding the body
 * where they differ). One Durable Object instance per mailbox
 * (`mbx:<workspaceId>:<accountId>`); every table here is scoped to that one
 * mailbox, so none of them carry a `workspace_id`/`account_id` column — those
 * live in `meta` instead (`bindRef`, task C1).
 *
 * Booleans are stored as `INTEGER` 0/1 (SQLite has no boolean type and the
 * test fakes reject boolean bindings, matching workerd). Every timestamp is
 * an epoch-millisecond `INTEGER`, never a SQLite `TEXT` date.
 *
 * Decisions overrides applied here (see the design doc's "Decisions" block):
 *   3. Search is two FTS5 tables, not the one `messages_fts` the design body's
 *      §3.1 draft still shows:
 *        - `messages_fts_meta`: `tokenize='trigram'` over `subject`, `sender`
 *          (the from name + address) and `recipients` (to/cc names +
 *          addresses) — substring search.
 *        - `messages_fts_body`: `unicode61 remove_diacritics 2`,
 *          `detail=column`, contentless, one `body` column holding the first
 *          8 KB of plain text — token-prefix search.
 *      Both are `content=''` (contentless) with `contentless_delete=1`, rowid
 *      = `messages.rowid`, maintained by `writes.ts` (insert at ingest, never
 *      updated since the indexed fields are immutable after ingest, deleted at
 *      hard delete).
 *   4. No `body_key` / `search_text` columns: bodies and raw MIME live at
 *      deterministic R2 keys (`store/bodies.ts`). `body_bits` only records
 *      which of the three R2 objects exist for a message.
 *
 * "Where the plan or ADR is wrong" item 1 (the object needs `message_addresses`
 * and `drafts`, missing from the design body's own table list) is folded in
 * here directly: both tables are present below.
 *
 * `meta`'s own `CREATE TABLE` is deliberately NOT part of this file's
 * migration list — `migrate.ts` creates it with `IF NOT EXISTS` before it can
 * read `schema_version`, the same bootstrap order `mail-index/mail-index.ts`
 * already uses. Every other table from design §3.1 is here.
 */

export interface MailboxMigration {
  version: number;
  statements: readonly string[];
}

/**
 * Version 1: every table `MailboxObject` has on day one. Append-only from
 * here — a later schema change is a new migration, never an edit to this one
 * (design §3.4; `migrate.test.ts` applies every version from empty, and from
 * every version in between, so a rewritten v1 would silently stop being
 * exercised on objects that already migrated past it).
 */
export const MAILBOX_SCHEMA_V1: readonly string[] = [
  // ---------------------------------------------------------------------
  // messages
  // ---------------------------------------------------------------------
  `CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    rfc_message_id TEXT NOT NULL,
    external_message_id TEXT,
    provider_message_id TEXT,
    thread_id TEXT,
    thread_key TEXT NOT NULL,
    conversation_id TEXT,
    from_email TEXT NOT NULL DEFAULT '',
    from_name TEXT,
    from_json TEXT NOT NULL,
    to_json TEXT NOT NULL DEFAULT '[]',
    cc_json TEXT,
    bcc_json TEXT,
    reply_to_json TEXT,
    subject TEXT,
    subject_norm TEXT,
    preview TEXT,
    sent_at INTEGER NOT NULL,
    received_at INTEGER,
    sort_at INTEGER NOT NULL,
    is_read INTEGER NOT NULL DEFAULT 0,
    is_flagged INTEGER NOT NULL DEFAULT 0,
    is_draft INTEGER NOT NULL DEFAULT 0,
    is_reply INTEGER NOT NULL DEFAULT 0,
    is_forwarded INTEGER NOT NULL DEFAULT 0,
    labels_json TEXT NOT NULL DEFAULT '[]',
    categories_json TEXT,
    in_trash INTEGER NOT NULL DEFAULT 0,
    in_spam INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    starred INTEGER NOT NULL DEFAULT 0,
    important INTEGER NOT NULL DEFAULT 0,
    has_attachments INTEGER NOT NULL DEFAULT 0,
    attachment_count INTEGER NOT NULL DEFAULT 0,
    in_reply_to TEXT,
    references_json TEXT,
    priority TEXT,
    size_bytes INTEGER,
    spf_status TEXT,
    dkim_status TEXT,
    dmarc_status TEXT,
    source TEXT,
    send_status TEXT,
    scheduled_for INTEGER,
    trigger_run_id TEXT,
    idempotency_key TEXT,
    snoozed_until INTEGER,
    snoozed_at INTEGER,
    unsnoozed_at INTEGER,
    unsnoozed_early INTEGER,
    resnoozed_at INTEGER,
    delivery_status TEXT,
    delivery_detail TEXT,
    delivery_updated_at INTEGER,
    body_bits INTEGER NOT NULL DEFAULT 0,
    extra_json TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER,
    clk_read INTEGER NOT NULL DEFAULT 0,
    clk_labels INTEGER NOT NULL DEFAULT 0,
    clk_flag INTEGER NOT NULL DEFAULT 0,
    clk_delete INTEGER NOT NULL DEFAULT 0,
    clk_snooze INTEGER NOT NULL DEFAULT 0,
    clk_send INTEGER NOT NULL DEFAULT 0,
    clk_delivery INTEGER NOT NULL DEFAULT 0,
    clk_meta INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX messages_rfc_idx ON messages(rfc_message_id)`,
  `CREATE INDEX messages_ext_idx ON messages(external_message_id) WHERE external_message_id IS NOT NULL`,
  `CREATE INDEX messages_provider_idx ON messages(provider_message_id) WHERE provider_message_id IS NOT NULL`,
  `CREATE INDEX messages_thread_idx ON messages(thread_key, sort_at)`,
  `CREATE INDEX messages_list_idx ON messages(sent_at DESC, id DESC) WHERE deleted_at IS NULL`,
  `CREATE INDEX messages_subject_idx ON messages(subject_norm, sent_at DESC) WHERE deleted_at IS NULL`,
  `CREATE INDEX messages_snooze_idx ON messages(snoozed_until) WHERE snoozed_until IS NOT NULL`,
  `CREATE INDEX messages_scheduled_idx ON messages(scheduled_for) WHERE send_status = 'scheduled'`,
  `CREATE UNIQUE INDEX messages_idem_idx ON messages(idempotency_key) WHERE idempotency_key IS NOT NULL`,
  `CREATE INDEX messages_source_sent_idx ON messages(source, sent_at)`,
  `CREATE INDEX messages_updated_idx ON messages(updated_at)`,
  `CREATE INDEX messages_unread_idx ON messages(sort_at DESC) WHERE is_read = 0 AND deleted_at IS NULL`,

  // ---------------------------------------------------------------------
  // message_labels — exact label membership (the message's own labels_json,
  // one row per entry), independent of the folder-key/trash/spam/archive
  // filtering `label_counts`/`thread_labels` apply.
  // ---------------------------------------------------------------------
  `CREATE TABLE message_labels (
    label_key TEXT NOT NULL,
    message_id TEXT NOT NULL,
    PRIMARY KEY (label_key, message_id)
  ) WITHOUT ROWID`,
  `CREATE INDEX message_labels_msg_idx ON message_labels(message_id)`,

  // ---------------------------------------------------------------------
  // message_addresses — "Where the plan or ADR is wrong" item 1. Every
  // participant address (from/to/cc/bcc) of every live or deleted message,
  // for delivery-status matching, the CRM counterparty tab, recent
  // correspondents and To/From filters.
  // ---------------------------------------------------------------------
  `CREATE TABLE message_addresses (
    address TEXT NOT NULL,
    sent_at INTEGER NOT NULL,
    message_id TEXT NOT NULL,
    role TEXT NOT NULL,
    name TEXT,
    PRIMARY KEY (address, sent_at, message_id, role)
  ) WITHOUT ROWID`,
  `CREATE INDEX message_addresses_msg_idx ON message_addresses(message_id)`,

  // ---------------------------------------------------------------------
  // threads — one row per live thread, recomputed wholesale by
  // `refreshThread()` from the thread's live messages.
  // ---------------------------------------------------------------------
  `CREATE TABLE threads (
    thread_key TEXT PRIMARY KEY,
    latest_at INTEGER NOT NULL,
    latest_message_id TEXT NOT NULL,
    first_message_id TEXT NOT NULL,
    subject TEXT,
    preview TEXT,
    latest_from_json TEXT,
    participants_json TEXT NOT NULL,
    labels_json TEXT NOT NULL,
    message_count INTEGER NOT NULL,
    unread_count INTEGER NOT NULL,
    has_attachments INTEGER NOT NULL,
    is_starred INTEGER NOT NULL,
    scheduled_for INTEGER,
    send_status TEXT,
    updated_at INTEGER NOT NULL
  ) WITHOUT ROWID`,

  // ---------------------------------------------------------------------
  // thread_labels — which threads a folder key's listing shows, ordered by
  // recency. `match_count` is how many of the thread's live messages
  // currently carry the key; the row exists only while that count is > 0.
  // ---------------------------------------------------------------------
  `CREATE TABLE thread_labels (
    label_key TEXT NOT NULL,
    thread_key TEXT NOT NULL,
    latest_at INTEGER NOT NULL,
    match_count INTEGER NOT NULL,
    PRIMARY KEY (label_key, thread_key)
  ) WITHOUT ROWID`,
  `CREATE INDEX thread_labels_page_idx ON thread_labels(label_key, latest_at DESC, thread_key)`,
  `CREATE INDEX thread_labels_thread_idx ON thread_labels(thread_key)`,

  // ---------------------------------------------------------------------
  // label_counts — the mailbox's folder badges. One row per folder key
  // (`__total`, `__all`, `__scheduled`, a system slug, or `lower(user
  // label)`); created on first use by the upsert in `writes.ts`.
  // ---------------------------------------------------------------------
  `CREATE TABLE label_counts (
    label_key TEXT PRIMARY KEY,
    messages INTEGER NOT NULL DEFAULT 0,
    unread INTEGER NOT NULL DEFAULT 0,
    threads INTEGER NOT NULL DEFAULT 0
  ) WITHOUT ROWID`,

  // ---------------------------------------------------------------------
  // attachments
  // ---------------------------------------------------------------------
  `CREATE TABLE attachments (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    file_name TEXT NOT NULL,
    content_type TEXT,
    size INTEGER NOT NULL DEFAULT 0,
    is_inline INTEGER NOT NULL DEFAULT 0,
    content_id TEXT,
    content_disposition TEXT,
    checksum TEXT,
    storage_path TEXT,
    download_url TEXT,
    external_attachment_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
  )`,
  `CREATE INDEX attachments_msg_idx ON attachments(message_id)`,
  `CREATE INDEX attachments_recent_idx ON attachments(created_at DESC, id DESC) WHERE deleted_at IS NULL AND is_inline = 0`,

  // ---------------------------------------------------------------------
  // Search: two FTS5 tables (Decisions #3), not the design body's single
  // `messages_fts`. rowid = messages.rowid in both.
  // ---------------------------------------------------------------------
  `CREATE VIRTUAL TABLE messages_fts_meta USING fts5(
    subject, sender, recipients,
    content='', contentless_delete=1, tokenize='trigram'
  )`,
  `CREATE VIRTUAL TABLE messages_fts_body USING fts5(
    body,
    content='', contentless_delete=1, detail=column, tokenize='unicode61 remove_diacritics 2'
  )`,

  // ---------------------------------------------------------------------
  // subscriptions — mailing lists / newsletters, mirrors tenant Postgres
  // `mail_subscriptions` one-for-one minus `account_id` (one mailbox here).
  // ---------------------------------------------------------------------
  `CREATE TABLE subscriptions (
    id TEXT PRIMARY KEY,
    sender_email TEXT NOT NULL UNIQUE,
    sender_name TEXT,
    sender_domain TEXT,
    list_id TEXT,
    unsubscribe_url TEXT,
    unsubscribe_mailto TEXT,
    one_click INTEGER NOT NULL DEFAULT 0,
    message_count INTEGER NOT NULL DEFAULT 0,
    last_subject TEXT,
    first_received_at INTEGER NOT NULL,
    last_received_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    unsubscribe_method TEXT,
    unsubscribed_at INTEGER,
    unsubscribed_by TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX subscriptions_recent_idx ON subscriptions(last_received_at DESC)`,

  // ---------------------------------------------------------------------
  // drafts — "Where the plan or ADR is wrong" item 1: drafts move into the
  // object (the stats endpoint counts them; the design body's own table list
  // omitted this table even though §2 says drafts move in).
  // ---------------------------------------------------------------------
  `CREATE TABLE drafts (
    id TEXT PRIMARY KEY,
    subject TEXT,
    to_json TEXT,
    cc_json TEXT,
    bcc_json TEXT,
    reply_to_json TEXT,
    body TEXT,
    html_body TEXT,
    importance TEXT,
    labels_json TEXT,
    attachment_ids_json TEXT,
    in_reply_to TEXT,
    original_message_id TEXT,
    is_reply INTEGER,
    is_forward INTEGER,
    has_attachments INTEGER NOT NULL DEFAULT 0,
    attachment_count INTEGER NOT NULL DEFAULT 0,
    last_auto_saved_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
  )`,
  `CREATE INDEX drafts_updated_idx ON drafts(updated_at DESC, id DESC) WHERE deleted_at IS NULL`,

  // ---------------------------------------------------------------------
  // outbox / pg_drift — background delivery queues the alarm drains (task
  // C1). `writes.ts` only ever inserts into `outbox`; it never reads it back.
  // ---------------------------------------------------------------------
  `CREATE TABLE outbox (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL,
    last_error TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX outbox_due_idx ON outbox(next_attempt_at)`,
  `CREATE TABLE pg_drift (
    message_id TEXT PRIMARY KEY,
    noted_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL
  ) WITHOUT ROWID`,
];

/** Every migration, in order. Append new versions here; never edit a landed one. */
export const MAILBOX_MIGRATIONS: readonly MailboxMigration[] = [{ version: 1, statements: MAILBOX_SCHEMA_V1 }];

/** The schema version this build of `MailboxObject` migrates up to. */
export const LATEST_MAILBOX_SCHEMA_VERSION: number = MAILBOX_MIGRATIONS[MAILBOX_MIGRATIONS.length - 1]!.version;
