CREATE TABLE "github_project_links" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"workspace_id" varchar(30) NOT NULL,
	"connection_id" varchar(30) NOT NULL,
	"project_id" varchar(255) NOT NULL,
	"project_v2_node_id" text NOT NULL,
	"project_v2_number" integer NOT NULL,
	"project_title" text,
	"owner_type" text NOT NULL,
	"owner_login" text NOT NULL,
	"repo_id" bigint,
	"repo_full_name" text,
	"status_field_id" text,
	"status_option_map" jsonb DEFAULT '[]'::jsonb,
	"sync_issues" boolean DEFAULT true NOT NULL,
	"sync_direction" text DEFAULT 'bidirectional' NOT NULL,
	"last_synced_at" timestamp,
	"last_error" text,
	"sync_cursor" text
);
--> statement-breakpoint
ALTER TABLE "github_issue_sync_map" DROP CONSTRAINT "github_issue_sync_map_repo_link_id_github_repo_links_id_fk";
--> statement-breakpoint
DROP INDEX "github_issue_sync_map_repo_link_id_idx";--> statement-breakpoint
DROP INDEX "github_issue_sync_map_repo_issue_unique";--> statement-breakpoint
ALTER TABLE "github_issue_sync_map" ADD COLUMN "project_link_id" varchar(30) NOT NULL;--> statement-breakpoint
ALTER TABLE "github_issue_sync_map" ADD COLUMN "project_item_node_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "github_issue_sync_map" ADD COLUMN "issue_node_id" text;--> statement-breakpoint
ALTER TABLE "github_issue_sync_map" ADD COLUMN "repo_id" bigint;--> statement-breakpoint
ALTER TABLE "github_project_links" ADD CONSTRAINT "github_project_links_connection_id_github_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."github_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "github_project_links_workspace_id_idx" ON "github_project_links" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "github_project_links_connection_id_idx" ON "github_project_links" USING btree ("connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "github_project_links_project_id_unique" ON "github_project_links" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "github_project_links_connection_node_unique" ON "github_project_links" USING btree ("connection_id","project_v2_node_id");--> statement-breakpoint
ALTER TABLE "github_issue_sync_map" ADD CONSTRAINT "github_issue_sync_map_project_link_id_github_project_links_id_fk" FOREIGN KEY ("project_link_id") REFERENCES "public"."github_project_links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "github_issue_sync_map_project_link_id_idx" ON "github_issue_sync_map" USING btree ("project_link_id");--> statement-breakpoint
CREATE UNIQUE INDEX "github_issue_sync_map_link_item_unique" ON "github_issue_sync_map" USING btree ("project_link_id","project_item_node_id");--> statement-breakpoint
ALTER TABLE "github_issue_sync_map" DROP COLUMN "repo_link_id";