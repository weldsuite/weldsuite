ALTER TABLE "device_tokens" ALTER COLUMN "is_active" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "crm_activities" ADD COLUMN "is_favorite" boolean DEFAULT false;