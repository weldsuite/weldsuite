ALTER TABLE "telephony_number_pricing" ADD COLUMN "stripe_price_id" varchar(255);--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "stripe_phone_subscription_id" varchar(255);