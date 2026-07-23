ALTER TABLE "domain_pricing" ALTER COLUMN "registrar" SET DEFAULT 'cloudflare';--> statement-breakpoint
ALTER TABLE "domain_pricing" ADD COLUMN "markup_amount" integer;--> statement-breakpoint
ALTER TABLE "domain_pricing" ADD COLUMN "markup_percent" numeric(5, 2);--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "cloudflare_account_id" text;