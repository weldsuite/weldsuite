CREATE TABLE "task_import_jobs" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp,
	"workspace_id" varchar(255) NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"project_id" varchar(255) NOT NULL,
	"r2_key" varchar(500) NOT NULL,
	"workflow_instance_id" varchar(255),
	"status" varchar(20) DEFAULT 'queued' NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"processed" integer DEFAULT 0 NOT NULL,
	"imported" integer DEFAULT 0 NOT NULL,
	"updated" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"errors" jsonb DEFAULT '[]'::jsonb,
	"error_message" varchar(1000)
);
--> statement-breakpoint
CREATE INDEX "task_import_jobs_workspace_idx" ON "task_import_jobs" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "task_import_jobs_project_idx" ON "task_import_jobs" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "task_import_jobs_status_idx" ON "task_import_jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "task_import_jobs_created_idx" ON "task_import_jobs" USING btree ("created_at");