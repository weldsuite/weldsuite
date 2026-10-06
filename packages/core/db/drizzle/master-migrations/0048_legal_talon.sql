CREATE TABLE "workflow_webhook_registry" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "user_apps" ALTER COLUMN "icon" SET DATA TYPE text;--> statement-breakpoint
CREATE INDEX "workflow_webhook_registry_workspace_id_idx" ON "workflow_webhook_registry" USING btree ("workspace_id");