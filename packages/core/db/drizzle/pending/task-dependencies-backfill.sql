-- WeldFlow FLOW-015, slice C (schedule): backfill of `task_dependencies` from `tasks.depends_on`.
--
-- NOT a migration yet. The integrator turns this into a custom migration
-- (`pnpm --filter @weldsuite/db db:generate --custom`) that runs AFTER the one
-- that creates `task_dependencies`, in the same release. Do not apply it by hand.
--
-- One `fs` / lag 0 row per entry of every live task's `depends_on` array:
--   - the task and the task it depends on are both live (not soft-deleted),
--   - both belong to the same project (a dependency between projects is a RAID
--     dependency; such pairs stay in the arrays only),
--   - the project exists (`task_dependencies.project_id` is a foreign key),
--   - a task never depends on itself.
-- `blocks` is not read: it is the reciprocal side of `depends_on`, which the
-- tasks routes have always kept in step, so it holds the same pairs.
--
-- Idempotent: the id is derived from the pair, and a pair that already has a
-- row (made through /api/task-dependencies, or by an earlier run) is left alone,
-- so a row keeps the type and lag it was given. Safe to run again.
INSERT INTO "task_dependencies" ("id", "project_id", "predecessor_id", "successor_id", "type", "lag_days", "created_by", "created_at", "updated_at")
SELECT
  'tdp_' || substr(md5(p."id" || '>' || s."id"), 1, 16),
  s."project_id",
  p."id",
  s."id",
  'fs',
  0,
  'system',
  now(),
  now()
FROM "tasks" s
CROSS JOIN LATERAL jsonb_array_elements_text(
  CASE WHEN jsonb_typeof(s."depends_on"::jsonb) = 'array' THEN s."depends_on"::jsonb ELSE '[]'::jsonb END
) AS dep("id")
JOIN "tasks" p ON p."id" = dep."id"
WHERE s."deleted_at" IS NULL
  AND s."project_id" IS NOT NULL
  AND p."deleted_at" IS NULL
  AND p."project_id" = s."project_id"
  AND p."id" <> s."id"
  AND EXISTS (SELECT 1 FROM "projects" pr WHERE pr."id" = s."project_id")
GROUP BY s."project_id", p."id", s."id"
ON CONFLICT ("predecessor_id", "successor_id") DO NOTHING;
