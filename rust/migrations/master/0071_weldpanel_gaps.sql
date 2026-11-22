CREATE TABLE "panel_custom_domains" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"project_id" varchar(30) NOT NULL,
	"hostname" varchar(253) NOT NULL,
	"cf_custom_hostname_id" varchar(64),
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"ssl_status" varchar(40),
	"verification" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_error" varchar(500),
	"last_checked_at" timestamp with time zone,
	"created_by_user_id" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "panel_schedule_registry" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"kind" varchar(20) NOT NULL,
	"object_id" varchar(30) NOT NULL,
	"next_run_at" timestamp with time zone NOT NULL,
	"locked_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "panel_share_registry" (
	"token_hash" varchar(64) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"project_id" varchar(30) NOT NULL,
	"link_id" varchar(30) NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "panel_custom_domains_hostname_idx" ON "panel_custom_domains" USING btree ("hostname");--> statement-breakpoint
CREATE INDEX "panel_custom_domains_project_idx" ON "panel_custom_domains" USING btree ("workspace_id","project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "panel_schedule_registry_object_idx" ON "panel_schedule_registry" USING btree ("kind","object_id");--> statement-breakpoint
CREATE INDEX "panel_schedule_registry_due_idx" ON "panel_schedule_registry" USING btree ("next_run_at");--> statement-breakpoint
CREATE INDEX "panel_share_registry_link_idx" ON "panel_share_registry" USING btree ("workspace_id","link_id");