CREATE TABLE "workflow_versions" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"workflow_id" varchar(30) NOT NULL,
	"version" integer NOT NULL,
	"name" varchar(255) NOT NULL,
	"status" varchar(20) NOT NULL,
	"triggers" jsonb,
	"steps" jsonb,
	"settings" jsonb,
	"created_by" varchar(255),
	"reason" varchar(20) NOT NULL,
	"restored_from_version" integer,
	"note" text,
	CONSTRAINT "workflow_versions_workflow_version_unique" UNIQUE("workflow_id","version")
);
--> statement-breakpoint
ALTER TABLE "workflow_schedules" ALTER COLUMN "cron_expression" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_schedules" ADD COLUMN "schedule_type" varchar(20) DEFAULT 'recurring' NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_schedules" ADD COLUMN "execute_at" timestamp;--> statement-breakpoint
CREATE INDEX "workflow_versions_workflow_idx" ON "workflow_versions" USING btree ("workflow_id");