ALTER TABLE "companies" ADD COLUMN "funding_raised" jsonb;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "foundation_date" timestamp;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "instagram_url" varchar(500);--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "angellist_url" varchar(500);--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "twitter_follower_count" integer;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "created_by" varchar(255);