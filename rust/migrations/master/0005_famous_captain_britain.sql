ALTER TABLE "plans" ADD COLUMN "price_per_user" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "included_users" integer DEFAULT 1;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "monthly_credits" integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "credits_rollover_cap" integer;