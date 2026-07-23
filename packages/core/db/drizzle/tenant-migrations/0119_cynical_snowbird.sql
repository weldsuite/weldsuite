ALTER TYPE "public"."mail_provider" ADD VALUE 'cloudflare' BEFORE 'custom';--> statement-breakpoint
ALTER TABLE "mail_domains" ALTER COLUMN "mail_provider" SET DEFAULT 'cloudflare';--> statement-breakpoint
ALTER TABLE "mail_domains" ALTER COLUMN "send_provider" SET DEFAULT 'cloudflare';--> statement-breakpoint
ALTER TABLE "mail_domains" ALTER COLUMN "receive_provider" SET DEFAULT 'cloudflare';--> statement-breakpoint
ALTER TABLE "mail_domains" ADD COLUMN "cloudflare_routing_rule_id" varchar(255);