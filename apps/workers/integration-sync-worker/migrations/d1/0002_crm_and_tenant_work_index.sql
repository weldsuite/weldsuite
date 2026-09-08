-- CRM due-index + tenant work queue (webhook retries / workflow polls).
-- Same D1 as connector_sync_index so quiet cron ticks never open tenant Neon.
--
-- Applied automatically on deploy via:
--   pnpm --filter integration-sync-worker d1:migrate:<env>

CREATE TABLE IF NOT EXISTS crm_sync_index (
  connection_id     TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL,
  clerk_org_id      TEXT NOT NULL,
  provider          TEXT NOT NULL,
  enabled           INTEGER NOT NULL DEFAULT 1,
  next_due_at       INTEGER NOT NULL,
  interval_minutes  INTEGER NOT NULL DEFAULT 360,
  renew_watch_at    INTEGER,
  last_triggered_at INTEGER,
  last_error        TEXT,
  updated_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS crm_sync_index_due
  ON crm_sync_index (enabled, next_due_at);

CREATE TABLE IF NOT EXISTS tenant_work_index (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL,
  clerk_org_id  TEXT NOT NULL,
  kind          TEXT NOT NULL,          -- webhook_retry | workflow_poll
  enabled       INTEGER NOT NULL DEFAULT 1,
  next_due_at   INTEGER NOT NULL,
  metadata      TEXT,                   -- JSON optional
  last_run_at   INTEGER,
  last_error    TEXT,
  updated_at    INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS tenant_work_index_unique
  ON tenant_work_index (workspace_id, kind);
CREATE INDEX IF NOT EXISTS tenant_work_index_due
  ON tenant_work_index (enabled, kind, next_due_at);
