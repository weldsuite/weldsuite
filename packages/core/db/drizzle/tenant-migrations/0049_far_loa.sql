CREATE TABLE "helpdesk_workflows" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"name" varchar(255) NOT NULL,
	"description" text,
	"status" varchar(20) DEFAULT 'draft' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"triggers" jsonb,
	"steps" jsonb,
	"settings" jsonb,
	"created_by" varchar(255),
	"folder_id" varchar(255),
	"tags" jsonb,
	"execution_count" integer DEFAULT 0,
	"success_count" integer DEFAULT 0,
	"failure_count" integer DEFAULT 0,
	"average_execution_time" numeric(10, 2),
	"last_executed_at" timestamp,
	"template_id" varchar(30)
);
--> statement-breakpoint
ALTER TABLE "workflow_executions" DROP CONSTRAINT "workflow_executions_workflow_id_workflows_id_fk";
--> statement-breakpoint
ALTER TABLE "workflow_triggers" DROP CONSTRAINT "workflow_triggers_workflow_id_workflows_id_fk";
--> statement-breakpoint
ALTER TABLE "workflow_schedules" DROP CONSTRAINT "workflow_schedules_workflow_id_workflows_id_fk";
--> statement-breakpoint
ALTER TABLE "workflow_webhooks" DROP CONSTRAINT "workflow_webhooks_workflow_id_workflows_id_fk";
--> statement-breakpoint
ALTER TABLE "workflow_variables" DROP CONSTRAINT "workflow_variables_workflow_id_workflows_id_fk";
--> statement-breakpoint
ALTER TABLE "workflow_error_logs" DROP CONSTRAINT "workflow_error_logs_workflow_id_workflows_id_fk";
--> statement-breakpoint
CREATE INDEX "helpdesk_workflows_status_idx" ON "helpdesk_workflows" USING btree ("status");--> statement-breakpoint
CREATE INDEX "helpdesk_workflows_created_by_idx" ON "helpdesk_workflows" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "helpdesk_workflows_folder_idx" ON "helpdesk_workflows" USING btree ("folder_id");