CREATE TABLE "panel_alert_events" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"alert_id" varchar(30) NOT NULL,
	"project_id" varchar(30) NOT NULL,
	"kind" varchar(20) NOT NULL,
	"value" double precision,
	"bound" double precision,
	"message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "panel_alerts" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"project_id" varchar(30) NOT NULL,
	"name" varchar(255) NOT NULL,
	"report_id" varchar(30),
	"spec" jsonb,
	"series_index" integer DEFAULT 0 NOT NULL,
	"condition" jsonb NOT NULL,
	"check_interval" varchar(20) DEFAULT 'daily' NOT NULL,
	"channels" jsonb NOT NULL,
	"slack_webhook_ciphertext" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"state" varchar(20) DEFAULT 'pending' NOT NULL,
	"last_value" double precision,
	"last_checked_at" timestamp with time zone,
	"last_fired_at" timestamp with time zone,
	"last_error" text,
	"snoozed_until" timestamp with time zone,
	"owner_user_id" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "panel_annotations" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"project_id" varchar(30) NOT NULL,
	"report_id" varchar(30),
	"occurred_at" timestamp with time zone NOT NULL,
	"label" varchar(200) NOT NULL,
	"description" text,
	"created_by_user_id" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "panel_comments" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"project_id" varchar(30) NOT NULL,
	"target_type" varchar(20) NOT NULL,
	"target_id" varchar(30) NOT NULL,
	"body" text NOT NULL,
	"author_user_id" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "panel_computed_properties" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"project_id" varchar(30) NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"definition" jsonb NOT NULL,
	"owner_user_id" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "panel_custom_events" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"project_id" varchar(30) NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"definition" jsonb NOT NULL,
	"owner_user_id" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "panel_export_runs" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"export_id" varchar(30) NOT NULL,
	"project_id" varchar(30) NOT NULL,
	"table_name" varchar(20) NOT NULL,
	"window_from" timestamp with time zone NOT NULL,
	"window_to" timestamp with time zone NOT NULL,
	"status" varchar(20) DEFAULT 'running' NOT NULL,
	"rows" integer DEFAULT 0 NOT NULL,
	"bytes" bigint DEFAULT 0 NOT NULL,
	"files" integer DEFAULT 0 NOT NULL,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "panel_exports" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"project_id" varchar(30) NOT NULL,
	"name" varchar(255) NOT NULL,
	"destination" jsonb NOT NULL,
	"secret_ciphertext" text NOT NULL,
	"tables" jsonb NOT NULL,
	"frequency" varchar(20) DEFAULT 'daily' NOT NULL,
	"start_at" timestamp with time zone NOT NULL,
	"exported_until" timestamp with time zone,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_error" text,
	"created_by_user_id" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "panel_group_types" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"project_id" varchar(30) NOT NULL,
	"group_type" varchar(32) NOT NULL,
	"name_singular" varchar(100) NOT NULL,
	"name_plural" varchar(100) NOT NULL,
	"crm_match_property" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "panel_metric_trees" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"project_id" varchar(30) NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"nodes" jsonb NOT NULL,
	"owner_user_id" varchar(255) NOT NULL,
	"visibility" varchar(20) DEFAULT 'private' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "panel_path_rules" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"project_id" varchar(30) NOT NULL,
	"position" integer NOT NULL,
	"pattern" varchar(500) NOT NULL,
	"replacement" varchar(500) NOT NULL,
	"description" text,
	"created_by_user_id" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "panel_report_versions" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"report_id" varchar(30) NOT NULL,
	"version" integer NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"spec" jsonb NOT NULL,
	"created_by_user_id" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "panel_share_links" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"project_id" varchar(30) NOT NULL,
	"target_type" varchar(20) NOT NULL,
	"target_id" varchar(30) NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"token_prefix" varchar(16) NOT NULL,
	"allow_embed" boolean DEFAULT false NOT NULL,
	"allow_date_change" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"last_viewed_at" timestamp with time zone,
	"view_count" integer DEFAULT 0 NOT NULL,
	"created_by_user_id" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "panel_subscriptions" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"project_id" varchar(30) NOT NULL,
	"name" varchar(255) NOT NULL,
	"target_type" varchar(20) NOT NULL,
	"target_id" varchar(30) NOT NULL,
	"schedule" jsonb NOT NULL,
	"channels" jsonb NOT NULL,
	"slack_webhook_ciphertext" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"next_run_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"last_error" text,
	"owner_user_id" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "panel_dashboard_tiles" ALTER COLUMN "report_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "panel_dashboard_tiles" ADD COLUMN "kind" varchar(20) DEFAULT 'report' NOT NULL;--> statement-breakpoint
ALTER TABLE "panel_dashboard_tiles" ADD COLUMN "text" text;--> statement-breakpoint
ALTER TABLE "panel_dashboards" ADD COLUMN "filters" jsonb;--> statement-breakpoint
ALTER TABLE "panel_dashboards" ADD COLUMN "template" varchar(50);--> statement-breakpoint
CREATE INDEX "panel_alert_events_alert_idx" ON "panel_alert_events" USING btree ("alert_id","created_at");--> statement-breakpoint
CREATE INDEX "panel_alerts_project_idx" ON "panel_alerts" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "panel_annotations_project_idx" ON "panel_annotations" USING btree ("project_id","occurred_at");--> statement-breakpoint
CREATE INDEX "panel_comments_target_idx" ON "panel_comments" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "panel_computed_properties_project_idx" ON "panel_computed_properties" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "panel_custom_events_project_idx" ON "panel_custom_events" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "panel_export_runs_export_idx" ON "panel_export_runs" USING btree ("export_id","started_at");--> statement-breakpoint
CREATE INDEX "panel_exports_project_idx" ON "panel_exports" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "panel_group_types_type_idx" ON "panel_group_types" USING btree ("project_id","group_type");--> statement-breakpoint
CREATE INDEX "panel_metric_trees_project_idx" ON "panel_metric_trees" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "panel_path_rules_project_idx" ON "panel_path_rules" USING btree ("project_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "panel_report_versions_report_idx" ON "panel_report_versions" USING btree ("report_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "panel_share_links_token_idx" ON "panel_share_links" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "panel_share_links_target_idx" ON "panel_share_links" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "panel_subscriptions_project_idx" ON "panel_subscriptions" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "panel_subscriptions_target_idx" ON "panel_subscriptions" USING btree ("target_type","target_id");