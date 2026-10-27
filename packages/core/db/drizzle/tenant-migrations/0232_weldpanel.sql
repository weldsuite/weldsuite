CREATE TABLE "panel_ai_summaries" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"project_id" varchar(30) NOT NULL,
	"scope" varchar(20) NOT NULL,
	"session_id" varchar(64),
	"filter_hash" varchar(64),
	"summary" jsonb NOT NULL,
	"model_id" varchar(100) NOT NULL,
	"credits_charged" integer DEFAULT 0 NOT NULL,
	"created_by_user_id" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "panel_cohorts" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"project_id" varchar(30) NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"filter" jsonb NOT NULL,
	"owner_user_id" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "panel_dashboard_tiles" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"dashboard_id" varchar(30) NOT NULL,
	"report_id" varchar(30) NOT NULL,
	"layout" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "panel_dashboards" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"project_id" varchar(30) NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"owner_user_id" varchar(255) NOT NULL,
	"visibility" varchar(20) DEFAULT 'private' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "panel_event_definitions" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"project_id" varchar(30) NOT NULL,
	"kind" varchar(20) NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"hidden" boolean DEFAULT false NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"updated_by_user_id" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "panel_heatmap_pages" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"project_id" varchar(30) NOT NULL,
	"name" varchar(255) NOT NULL,
	"url_pattern" varchar(1000) NOT NULL,
	"created_by_user_id" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "panel_projects" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"kind" varchar(20) DEFAULT 'website' NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"token" varchar(64) NOT NULL,
	"allowed_domains" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"settings" jsonb NOT NULL,
	"created_by_user_id" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "panel_reports" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"project_id" varchar(30) NOT NULL,
	"kind" varchar(20) NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"spec" jsonb NOT NULL,
	"owner_user_id" varchar(255) NOT NULL,
	"visibility" varchar(20) DEFAULT 'private' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "panel_session_favorites" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"project_id" varchar(30) NOT NULL,
	"session_id" varchar(64) NOT NULL,
	"note" text,
	"favorited_by_user_id" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "panel_ai_summaries_session_idx" ON "panel_ai_summaries" USING btree ("project_id","session_id");--> statement-breakpoint
CREATE INDEX "panel_ai_summaries_filter_idx" ON "panel_ai_summaries" USING btree ("project_id","filter_hash");--> statement-breakpoint
CREATE INDEX "panel_cohorts_project_idx" ON "panel_cohorts" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "panel_dashboard_tiles_dashboard_idx" ON "panel_dashboard_tiles" USING btree ("dashboard_id");--> statement-breakpoint
CREATE INDEX "panel_dashboards_project_idx" ON "panel_dashboards" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "panel_event_definitions_name_idx" ON "panel_event_definitions" USING btree ("project_id","kind","name");--> statement-breakpoint
CREATE INDEX "panel_heatmap_pages_project_idx" ON "panel_heatmap_pages" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "panel_projects_token_idx" ON "panel_projects" USING btree ("token");--> statement-breakpoint
CREATE INDEX "panel_reports_project_idx" ON "panel_reports" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "panel_reports_owner_idx" ON "panel_reports" USING btree ("owner_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "panel_session_favorites_session_idx" ON "panel_session_favorites" USING btree ("project_id","session_id");