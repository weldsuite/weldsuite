ALTER TABLE "project_labels" ADD COLUMN IF NOT EXISTS "project_id" varchar(255);
--> statement-breakpoint
-- Backfill: each existing workspace-shared label (project_id IS NULL) is
-- duplicated into every active project, task.labels arrays are rewritten to
-- point at the new per-project copies, and the original shared rows are
-- soft-deleted. After this every project owns its own independent copy of
-- the seed labels and new labels are scoped per-project going forward.
DO $$
DECLARE
  rec RECORD;
  new_label_id text;
BEGIN
  FOR rec IN
    SELECT pl.id AS label_id, p.id AS project_id
    FROM project_labels pl
    CROSS JOIN projects p
    WHERE pl.project_id IS NULL
      AND pl.deleted_at IS NULL
      AND p.deleted_at IS NULL
  LOOP
    new_label_id := 'plbl_mig_' || replace(gen_random_uuid()::text, '-', '');

    INSERT INTO project_labels (id, name, color, project_id, created_at, updated_at)
    SELECT new_label_id, name, color, rec.project_id, created_at, NOW()
    FROM project_labels
    WHERE id = rec.label_id;

    UPDATE tasks
    SET labels = (
      SELECT jsonb_agg(
        CASE WHEN elem #>> '{}' = rec.label_id THEN to_jsonb(new_label_id) ELSE elem END
      )
      FROM jsonb_array_elements(tasks.labels) AS elem
    )
    WHERE project_id = rec.project_id
      AND labels IS NOT NULL
      AND jsonb_typeof(labels) = 'array'
      AND labels @> to_jsonb(ARRAY[rec.label_id]);
  END LOOP;

  UPDATE project_labels
  SET deleted_at = NOW(), updated_at = NOW()
  WHERE project_id IS NULL
    AND deleted_at IS NULL;
END $$;
