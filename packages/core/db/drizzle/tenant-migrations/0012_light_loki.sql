ALTER TYPE "public"."mail_provider" ADD VALUE 'resend' BEFORE 'custom';--> statement-breakpoint
ALTER TYPE "public"."mail_provider" ADD VALUE 'smtp' BEFORE 'custom';--> statement-breakpoint
ALTER TABLE "mail_accounts" ALTER COLUMN "provider" SET DEFAULT 'imap';--> statement-breakpoint
ALTER TABLE "mail_domains" ALTER COLUMN "mail_provider" SET DEFAULT 'resend';--> statement-breakpoint
ALTER TABLE "mail_accounts" ADD COLUMN "send_provider" varchar(50);--> statement-breakpoint
ALTER TABLE "mail_accounts" ADD COLUMN "receive_provider" varchar(50);--> statement-breakpoint
ALTER TABLE "mail_domains" ADD COLUMN "send_provider" varchar(50) DEFAULT 'resend';--> statement-breakpoint
ALTER TABLE "mail_domains" ADD COLUMN "receive_provider" varchar(50) DEFAULT 'cloudflare';--> statement-breakpoint
ALTER TABLE "mail_domains" ADD COLUMN "resend_domain_id" varchar(255);--> statement-breakpoint
ALTER TABLE "mail_domains" ADD COLUMN "resend_status" varchar(50);--> statement-breakpoint
ALTER TABLE "mail_domains" ADD COLUMN "resend_synced_at" timestamp;--> statement-breakpoint
ALTER TABLE "mail_domains" ADD COLUMN "cloudflare_zone_id" varchar(255);--> statement-breakpoint
ALTER TABLE "mail_domains" ADD COLUMN "cloudflare_routing_enabled" boolean DEFAULT false;