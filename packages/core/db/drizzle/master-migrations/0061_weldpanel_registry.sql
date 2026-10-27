CREATE TABLE "panel_key_registry" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"key_hash" varchar(64) NOT NULL,
	"key_prefix" varchar(16) NOT NULL,
	"name" varchar(255) NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"project_id" varchar(30) NOT NULL,
	"created_by_user_id" varchar(255) NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "panel_project_registry" (
	"project_id" varchar(30) PRIMARY KEY NOT NULL,
	"token" varchar(64) NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"status" varchar(20) NOT NULL,
	"allowed_domains" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"settings" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "panel_usage_monthly" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"month" varchar(7) NOT NULL,
	"events" bigint DEFAULT 0 NOT NULL,
	"recordings" integer DEFAULT 0 NOT NULL,
	"event_blocks_charged" integer DEFAULT 0 NOT NULL,
	"recording_blocks_charged" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "panel_key_registry_hash_idx" ON "panel_key_registry" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "panel_key_registry_project_idx" ON "panel_key_registry" USING btree ("workspace_id","project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "panel_project_registry_token_idx" ON "panel_project_registry" USING btree ("token");--> statement-breakpoint
CREATE INDEX "panel_project_registry_workspace_idx" ON "panel_project_registry" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "panel_usage_monthly_workspace_month_idx" ON "panel_usage_monthly" USING btree ("workspace_id","month");