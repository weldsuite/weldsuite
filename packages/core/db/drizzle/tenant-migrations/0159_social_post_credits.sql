ALTER TABLE "social_posts" ADD COLUMN "credits_consumed" integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE "social_posts" ADD COLUMN "credit_transaction_id" varchar(30);
