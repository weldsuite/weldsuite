ALTER TABLE "workspaces" ADD COLUMN "provisioning_status" varchar(20) DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "provisioning_error" text;--> statement-breakpoint
UPDATE "workspaces" SET "provisioning_status" = 'ready' WHERE "database_provisioned_at" IS NOT NULL;