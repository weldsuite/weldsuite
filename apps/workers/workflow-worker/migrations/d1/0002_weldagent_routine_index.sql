-- D1 WeldAgent routine index — always-on timing layer for WeldAgent cron routines.
--
-- Lives in the same per-env schedule-index D1 database as schedule_index, but
-- in its own table: the WeldConnect schedule sweep must never pick these rows up.
-- app-api owns both sides — it writes rows on routine / agent changes
-- (src/lib/weldagent-routine-index.ts) and its hourly sweep
-- (src/cron/weldagent-routines.ts) reads due workspaces from here, so only
-- tenant Neon DBs with a routine actually due are woken.
--
-- Only live rows are stored: an enabled cron routine of an active agent.
-- Paused / deleted routines and routines of paused or draft agents are removed.
--
-- Applied automatically on deploy via:
--   pnpm --filter workflow-worker d1:migrate:<env>

CREATE TABLE IF NOT EXISTS weldagent_routine_index (
  routine_id   TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,      -- clerkOrgId; feeds getTenantDbForWorkspace
  agent_id     TEXT NOT NULL,
  next_run_at  INTEGER NOT NULL,   -- epoch ms
  updated_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS weldagent_routine_index_due ON weldagent_routine_index (next_run_at);
CREATE INDEX IF NOT EXISTS weldagent_routine_index_agent ON weldagent_routine_index (workspace_id, agent_id);
