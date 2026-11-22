ALTER TABLE "workflow_executions" ADD COLUMN "cf_workflow_instance_id" varchar(255);--> statement-breakpoint
ALTER TABLE "integration_connections" ADD COLUMN "external_account_id" varchar(255);