-- D1 schedule index — always-on timing layer for WeldConnect scheduled triggers.
--
-- Applied to the per-env D1 databases (weldsuite-schedule-index-{test,preview,
-- production}). The schedule sweep (apps/workers/workflow-worker/src/cron/schedule-sweep.ts)
-- polls this table every minute instead of fanning out to every tenant Neon DB;
-- app-api keeps it in sync on schedule CRUD.
--
-- Apply with: wrangler d1 execute weldsuite-schedule-index-<env> --remote \
--   --file apps/workers/workflow-worker/migrations/d1/0001_schedule_index.sql
-- (already applied to all three envs at creation time).

CREATE TABLE IF NOT EXISTS schedule_index (
  schedule_id     TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,        -- clerkOrgId; feeds getTenantDbForWorkspace
  workflow_id     TEXT NOT NULL,
  trigger_id      TEXT,
  cron_expression TEXT NOT NULL,
  timezone        TEXT NOT NULL DEFAULT 'UTC',
  start_date      INTEGER,              -- epoch ms, nullable
  end_date        INTEGER,              -- epoch ms, nullable
  next_run_at     INTEGER,              -- epoch ms; NULL = needs (re)compute
  last_run_at     INTEGER,              -- epoch ms; double-fire guard
  source          TEXT NOT NULL DEFAULT 'task',  -- task | helpdesk
  is_enabled      INTEGER NOT NULL DEFAULT 1,
  updated_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS schedule_index_due ON schedule_index (is_enabled, next_run_at);
CREATE INDEX IF NOT EXISTS schedule_index_workspace ON schedule_index (workspace_id);
