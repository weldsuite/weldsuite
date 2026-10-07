-- Adds one-time ("run once at <date/time> in <timezone>") schedule support to
-- the existing schedule_index table (see 0001_schedule_index.sql).
--
-- `schedule_type` distinguishes 'recurring' (cron_expression, matched every
-- tick) from 'one_time' (execute_at, a fixed epoch-ms instant fired exactly
-- once). `cron_expression` stays NOT NULL for backward compatibility —
-- one-time rows store '' there and are never matched against it.
--
-- Applied automatically on deploy via:
--   pnpm --filter workflow-worker d1:migrate:<env>

ALTER TABLE schedule_index ADD COLUMN schedule_type TEXT NOT NULL DEFAULT 'recurring';
ALTER TABLE schedule_index ADD COLUMN execute_at INTEGER; -- epoch ms; 'one_time' only
