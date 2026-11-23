CREATE TABLE "github_connections" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"workspace_id" varchar(30) NOT NULL,
	"installation_id" bigint NOT NULL,
	"app_slug" text NOT NULL,
	"owner_type" text NOT NULL,
	"owner_login" text NOT NULL,
	"webhook_secret" text,
	"created_by" varchar(30),
	"status" text DEFAULT 'active' NOT NULL,
	"scopes" jsonb,
	"installed_at" timestamp,
	"revoked_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "github_repo_links" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"workspace_id" varchar(30) NOT NULL,
	"connection_id" varchar(30) NOT NULL,
	"project_id" varchar(255),
	"repo_id" bigint NOT NULL,
	"repo_full_name" text NOT NULL,
	"default_branch" text,
	"sync_issues" boolean DEFAULT true NOT NULL,
	"sync_direction" text DEFAULT 'bidirectional' NOT NULL,
	"last_synced_at" timestamp,
	"sync_cursor" text
);
--> statement-breakpoint
CREATE TABLE "github_issue_sync_map" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"workspace_id" varchar(30) NOT NULL,
	"repo_link_id" varchar(30) NOT NULL,
	"task_id" varchar(255) NOT NULL,
	"issue_number" integer NOT NULL,
	"last_synced_task_updated_at" timestamp,
	"last_synced_issue_updated_at" timestamp,
	"last_writer_side" text
);
--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "model_id" SET DEFAULT 'anthropic/claude-sonnet-4-6';--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "github_issue_number" integer;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "github_repo_link_id" varchar(30);--> statement-breakpoint
ALTER TABLE "github_repo_links" ADD CONSTRAINT "github_repo_links_connection_id_github_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."github_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_issue_sync_map" ADD CONSTRAINT "github_issue_sync_map_repo_link_id_github_repo_links_id_fk" FOREIGN KEY ("repo_link_id") REFERENCES "public"."github_repo_links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "github_connections_workspace_id_idx" ON "github_connections" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "github_connections_installation_id_unique" ON "github_connections" USING btree ("installation_id");--> statement-breakpoint
CREATE INDEX "github_repo_links_workspace_id_idx" ON "github_repo_links" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "github_repo_links_project_id_idx" ON "github_repo_links" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "github_repo_links_connection_id_idx" ON "github_repo_links" USING btree ("connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "github_repo_links_connection_repo_unique" ON "github_repo_links" USING btree ("connection_id","repo_id");--> statement-breakpoint
CREATE INDEX "github_issue_sync_map_workspace_id_idx" ON "github_issue_sync_map" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "github_issue_sync_map_repo_link_id_idx" ON "github_issue_sync_map" USING btree ("repo_link_id");--> statement-breakpoint
CREATE UNIQUE INDEX "github_issue_sync_map_repo_issue_unique" ON "github_issue_sync_map" USING btree ("repo_link_id","issue_number");--> statement-breakpoint
CREATE UNIQUE INDEX "github_issue_sync_map_task_id_unique" ON "github_issue_sync_map" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "tasks_github_repo_link_idx" ON "tasks" USING btree ("github_repo_link_id");