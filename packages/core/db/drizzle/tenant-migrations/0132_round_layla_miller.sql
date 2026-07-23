ALTER TYPE "public"."host_domain_registration_status" ADD VALUE IF NOT EXISTS 'pending_payment' BEFORE 'pending_registration';--> statement-breakpoint
ALTER TYPE "public"."host_domain_registration_status" ADD VALUE IF NOT EXISTS 'pending_workflow' BEFORE 'registered';--> statement-breakpoint
ALTER TYPE "public"."host_domain_registration_status" ADD VALUE IF NOT EXISTS 'registration_failed';--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN IF NOT EXISTS "workflow_url" text;--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN IF NOT EXISTS "stripe_session_id" text;