CREATE TABLE "admin_audit_events" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255),
	"target_type" varchar(30) NOT NULL,
	"target_id" varchar(255) NOT NULL,
	"action" varchar(100) NOT NULL,
	"outcome" varchar(20) NOT NULL,
	"actor_email" varchar(255) NOT NULL,
	"actor_user_id" varchar(255),
	"reason" text,
	"details" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "comp_granted_at" timestamp;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "comp_ends_at" timestamp;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "comp_granted_by" varchar(255);--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "comp_reason" text;--> statement-breakpoint
CREATE INDEX "admin_audit_events_workspace_idx" ON "admin_audit_events" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "admin_audit_events_target_idx" ON "admin_audit_events" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "admin_audit_events_created_at_idx" ON "admin_audit_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "workspaces_comp_ends_at_idx" ON "workspaces" USING btree ("comp_ends_at");