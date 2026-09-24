-- D1 calendar replan index — always-on timing layer for the daily calendar replan.
--
-- Lives in the same per-env schedule-index D1 database as schedule_index, in
-- its own table. app-api owns both sides: it re-derives a workspace's row after
-- task / calendar-event writes (src/lib/calendar-replan-index.ts), and its daily
-- sweep (src/cron/calendar-replan.ts) reads due workspaces from here, so only
-- tenant Neon DBs with a stale auto-scheduled event are woken.
--
-- One row per workspace that has an auto-scheduled, confirmed event on an open
-- task. next_due_at is the earliest such event's start time: from then on the
-- replan has work in that workspace. Workspaces with none have no row.
--
-- Applied automatically on deploy via:
--   pnpm --filter workflow-worker d1:migrate:<env>

CREATE TABLE IF NOT EXISTS calendar_replan_index (
  workspace_id TEXT PRIMARY KEY,   -- clerkOrgId; feeds getTenantDbForWorkspace
  next_due_at  INTEGER NOT NULL,   -- epoch ms
  updated_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS calendar_replan_index_due ON calendar_replan_index (next_due_at);
