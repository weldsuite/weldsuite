ALTER TABLE "tasks" ADD COLUMN "stage_id" varchar(255);--> statement-breakpoint
ALTER TABLE "project_pipeline_stages" ADD COLUMN "system_status" varchar(50) DEFAULT 'in_progress' NOT NULL;