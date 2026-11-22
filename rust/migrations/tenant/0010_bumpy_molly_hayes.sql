ALTER TABLE "mail_labels" ADD COLUMN "ai_enabled" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "mail_labels" ADD COLUMN "ai_keywords" jsonb;--> statement-breakpoint
ALTER TABLE "mail_labels" ADD COLUMN "ai_description" text;