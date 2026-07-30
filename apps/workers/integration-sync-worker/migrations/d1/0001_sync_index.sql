-- D1 sync index — always-on timing layer for integration + connector syncs.
--
-- Replaces the per-workspace fan-out that opened EVERY tenant Neon DB every 30
-- minutes just to ask "is anything due?". Tenants with no integrations at all
-- were woken 48 times a day for nothing. The sweep
-- (apps/workers/integration-sync-worker/src/index.ts) now polls this one table
-- and a tenant DB is opened only when there is real work; app-api keeps the rows
-- in sync on connection CRUD.
--
-- Same shape and rationale as `schedule_index` (see
-- apps/workers/workflow-worker/migrations/d1/0001_schedule_index.sql), which
-- solved this for scheduled workflow triggers first.
--
-- Lives in the SAME D1 database as `schedule_index`
-- (weldsuite-schedule-index-{test,production}) rather than a new one: separate
-- tables, one binding to provision, and nothing queries across them. The
-- database name is therefore narrower than what it now holds — worth knowing
-- before going looking for a "sync-index" database that does not exist.
--
-- Apply with: wrangler d1 execute weldsuite-schedule-index-<env> --remote \
--   --file apps/workers/integration-sync-worker/migrations/d1/0001_sync_index.sql

CREATE TABLE IF NOT EXISTS sync_index (
  -- Connector rows are per (connection, entity type) because each is dispatched
  -- separately: `<connection_id>:<entity_type>`. Legacy rows are one per
  -- connection, so just `<connection_id>`.
  row_id          TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,        -- clerkOrgId; feeds getTenantDbForWorkspace
  -- 'connector' → enqueued onto the connector-sync queue.
  -- 'legacy'    → dispatched via app-api's internal /sync endpoint.
  engine          TEXT NOT NULL,
  connection_id   TEXT NOT NULL,
  entity_type     TEXT,                 -- connector rows only; NULL for legacy
  provider        TEXT NOT NULL,        -- connectorId, or the legacy provider slug
  -- Attributed as the owner of imported rows. Denormalised so dispatch needs no
  -- tenant read at all.
  owner_id        TEXT,
  interval_hours  INTEGER NOT NULL DEFAULT 6,
  next_run_at     INTEGER,              -- epoch ms; NULL = due immediately
  last_run_at     INTEGER,              -- epoch ms; double-fire guard
  -- Google Calendar watch channels expire (~7 days) and are renewed 24h out.
  -- Legacy google_calendar rows only; NULL everywhere else.
  watch_expires_at INTEGER,
  is_enabled      INTEGER NOT NULL DEFAULT 1,
  updated_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS sync_index_due ON sync_index (is_enabled, next_run_at);
CREATE INDEX IF NOT EXISTS sync_index_workspace ON sync_index (workspace_id);
CREATE INDEX IF NOT EXISTS sync_index_connection ON sync_index (connection_id);
CREATE INDEX IF NOT EXISTS sync_index_watch ON sync_index (is_enabled, watch_expires_at);
