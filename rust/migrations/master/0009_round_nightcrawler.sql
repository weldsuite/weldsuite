ALTER TABLE "database_pool" DROP CONSTRAINT "database_pool_shared_project_id_neon_shared_projects_id_fk";
--> statement-breakpoint
DROP INDEX "database_pool_shared_project_idx";--> statement-breakpoint
ALTER TABLE "database_pool" ADD COLUMN "connection_host" varchar(255);--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "neon_region" varchar(50);--> statement-breakpoint
ALTER TABLE "database_pool" DROP COLUMN "shared_project_id";--> statement-breakpoint
ALTER TABLE "workspaces" DROP COLUMN "database_url";