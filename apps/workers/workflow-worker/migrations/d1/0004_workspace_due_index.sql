-- D1 workspace due index — always-on timing layer for per-workspace sweeps.
--
-- Lives in the per-env schedule-index D1 database (SCHEDULE_INDEX) next to
-- schedule_index and weldagent_routine_index. One row per (kind, workspace)
-- that has work coming up, keyed by when that work is next due. A sweep reads
-- only this table and opens the tenant Neon DBs of the due rows, so idle
-- workspaces' computes stay suspended (AGENTS.md: "Never periodically wake
-- tenant databases").
--
-- Kinds and their owners (sweep + write paths):
--   mail_snooze      mail-api       (snoozed mail coming back to the inbox)
--   calendar_replan  calendar-api   (auto-scheduled task events slipping into the past)
--   domain_renew     host-api       (WeldHost domains entering the auto-renew window)
--
-- Write paths only ever pull next_due_at earlier (MIN); the sweep re-derives
-- the exact value from the tenant after doing the work, using `version` as a
-- compare-and-set token so it never overwrites a write that landed meanwhile.
-- Helpers: @weldsuite/worker-kit/due-index.
--
-- Applied automatically on deploy via:
--   pnpm --filter workflow-worker d1:migrate:<env>

CREATE TABLE IF NOT EXISTS workspace_due_index (
  kind         TEXT    NOT NULL,
  workspace_id TEXT    NOT NULL,             -- clerkOrgId; feeds getTenantDbForWorkspace
  next_due_at  INTEGER NOT NULL,             -- epoch ms
  updated_at   INTEGER NOT NULL,             -- epoch ms
  version      INTEGER NOT NULL DEFAULT 1,   -- bumped on every write
  PRIMARY KEY (kind, workspace_id)
);

CREATE INDEX IF NOT EXISTS workspace_due_index_due ON workspace_due_index (kind, next_due_at);
