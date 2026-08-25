-- D1 connector sync index — always-on schedule + probe copy of a WeldConnect
-- connection. The catch-up sweep (apps/workers/integration-sync-worker) polls
-- this table every 15 minutes instead of opening every tenant Neon; app-api
-- keeps it in sync on connect / pause / resume / disconnect / ingest.
--
-- Apply with: wrangler d1 execute weldsuite-connector-sync-index-<env> --remote \
--   --file apps/workers/integration-sync-worker/migrations/d1/0001_connector_sync_index.sql
-- (already applied to test + production at creation time; database_id values
-- live in app-api and integration-sync-worker wrangler.toml).

CREATE TABLE IF NOT EXISTS connector_sync_index (
  connection_id          TEXT PRIMARY KEY,
  workspace_id           TEXT NOT NULL,          -- internal workspace id
  clerk_org_id           TEXT NOT NULL,          -- Clerk org id (X-Workspace-Id)
  provider               TEXT NOT NULL,
  source_kind            TEXT NOT NULL DEFAULT 'connector',  -- connector | books | crm (later)
  mode                   TEXT NOT NULL,          -- webhook_catchup | poll
  enabled                INTEGER NOT NULL DEFAULT 1,
  next_due_at            INTEGER NOT NULL,       -- epoch ms
  interval_minutes       INTEGER NOT NULL,
  encrypted_credentials  TEXT,                   -- JSON map of field-encrypted secrets
  watermarks             TEXT NOT NULL DEFAULT '{}',
  enabled_syncs          TEXT,                   -- JSON string[] or NULL = all
  last_webhook_at        INTEGER,
  last_probe_at          INTEGER,
  last_ingest_at         INTEGER,
  last_error             TEXT,
  backoff_until          INTEGER,
  reconcile_fingerprint  TEXT,                   -- JSON { resource: count }
  next_reconcile_at      INTEGER,
  updated_at             INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS connector_sync_index_due
  ON connector_sync_index (enabled, next_due_at);
CREATE INDEX IF NOT EXISTS connector_sync_index_reconcile
  ON connector_sync_index (enabled, next_reconcile_at);
CREATE INDEX IF NOT EXISTS connector_sync_index_workspace
  ON connector_sync_index (workspace_id);
