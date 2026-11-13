ALTER TABLE "ai_provider_usage" ADD COLUMN "key_source" varchar(16) DEFAULT 'weldsuite' NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_provider_usage" ADD COLUMN "feature" varchar(64);