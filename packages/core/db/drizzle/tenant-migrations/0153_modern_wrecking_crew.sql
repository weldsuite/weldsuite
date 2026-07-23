ALTER TABLE "github_connections" ALTER COLUMN "workspace_id" SET DATA TYPE varchar(255);--> statement-breakpoint
ALTER TABLE "github_repo_links" ALTER COLUMN "workspace_id" SET DATA TYPE varchar(255);--> statement-breakpoint
ALTER TABLE "github_project_links" ALTER COLUMN "workspace_id" SET DATA TYPE varchar(255);--> statement-breakpoint
ALTER TABLE "github_issue_sync_map" ALTER COLUMN "workspace_id" SET DATA TYPE varchar(255);