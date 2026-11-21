-- Custom SQL migration file, put your code below! --
-- "In review" had two spellings: the default WeldFlow board stage stores `review`,
-- while some views and agents wrote `in_review`, which no board column matched.
-- The APIs now store `review` only; this moves the rows written before that.
-- updated_at is left alone: the task itself did not change.
UPDATE "tasks" SET "status" = 'review' WHERE "status" = 'in_review';--> statement-breakpoint
UPDATE "project_pipeline_stages" SET "system_status" = 'review' WHERE "system_status" = 'in_review';
