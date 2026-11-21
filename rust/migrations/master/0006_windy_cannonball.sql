ALTER TABLE "workspaces" ADD COLUMN "onboarding_completed_at" timestamp;--> statement-breakpoint
ALTER TABLE "enterprise_inquiries" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "feature_requests" DROP COLUMN "workspace_id";