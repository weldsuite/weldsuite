ALTER TABLE "workspaces" ALTER COLUMN "clerk_org_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "database_url" text;