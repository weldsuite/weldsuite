ALTER TABLE "workspaces" ADD COLUMN "paid_plan_required" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "trial_expired_at" timestamp;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "scheduled_deletion_at" timestamp;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "deletion_requested_at" timestamp;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "deletion_requested_by" varchar(255);--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "deletion_reason" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
CREATE INDEX "workspaces_scheduled_deletion_at_idx" ON "workspaces" USING btree ("scheduled_deletion_at");