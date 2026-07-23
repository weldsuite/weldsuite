ALTER TABLE "workspace_credits" ADD COLUMN "plan_credits" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_credits" ADD COLUMN "subscribed_credits" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_credits" ADD COLUMN "stripe_credits_item_id" varchar(255);--> statement-breakpoint
ALTER TABLE "workspace_credits" ADD COLUMN "stripe_credits_price_id" varchar(255);