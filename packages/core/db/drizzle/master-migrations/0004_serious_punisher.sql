CREATE TYPE "public"."neon_shared_project_status" AS ENUM('active', 'full', 'disabled');--> statement-breakpoint
CREATE TABLE "neon_shared_projects" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"neon_project_id" varchar(100) NOT NULL,
	"neon_project_name" varchar(255) NOT NULL,
	"region" varchar(50) DEFAULT 'aws-eu-central-1' NOT NULL,
	"main_branch_id" varchar(100),
	"connection_host" varchar(255),
	"connection_port" smallint DEFAULT 5432,
	"admin_role" varchar(100),
	"admin_password_encrypted" text,
	"database_count" smallint DEFAULT 0 NOT NULL,
	"max_databases" smallint DEFAULT 500 NOT NULL,
	"status" "neon_shared_project_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "neon_shared_projects_neon_project_id_unique" UNIQUE("neon_project_id")
);
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "neon_project_id" varchar(100);--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "neon_database_name" varchar(100);--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "shared_project_id" varchar(30);--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "neon_branch_id" varchar(100);--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "neon_role_name" varchar(100);--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "database_provisioned_at" timestamp;--> statement-breakpoint
CREATE INDEX "neon_shared_projects_status_idx" ON "neon_shared_projects" USING btree ("status");--> statement-breakpoint
CREATE INDEX "neon_shared_projects_region_idx" ON "neon_shared_projects" USING btree ("region");--> statement-breakpoint
CREATE INDEX "neon_shared_projects_database_count_idx" ON "neon_shared_projects" USING btree ("database_count");--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_shared_project_id_neon_shared_projects_id_fk" FOREIGN KEY ("shared_project_id") REFERENCES "public"."neon_shared_projects"("id") ON DELETE no action ON UPDATE no action;