CREATE TYPE "public"."database_pool_status" AS ENUM('available', 'assigned', 'error');--> statement-breakpoint
CREATE TABLE "database_pool" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"shared_project_id" varchar(30) NOT NULL,
	"neon_project_id" varchar(100) NOT NULL,
	"neon_branch_id" varchar(100),
	"database_name" varchar(100) NOT NULL,
	"role_name" varchar(100) NOT NULL,
	"database_url" text NOT NULL,
	"schema_version" varchar(50),
	"status" "database_pool_status" DEFAULT 'available' NOT NULL,
	"assigned_workspace_id" varchar(255),
	"assigned_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "database_pool" ADD CONSTRAINT "database_pool_shared_project_id_neon_shared_projects_id_fk" FOREIGN KEY ("shared_project_id") REFERENCES "public"."neon_shared_projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "database_pool_status_idx" ON "database_pool" USING btree ("status");--> statement-breakpoint
CREATE INDEX "database_pool_shared_project_idx" ON "database_pool" USING btree ("shared_project_id");--> statement-breakpoint
ALTER TABLE "plans" DROP COLUMN "max_storage";