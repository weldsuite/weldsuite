ALTER TABLE "panel_usage_monthly" ADD COLUMN "event_credits_charged" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "panel_usage_monthly" ADD COLUMN "recording_credits_charged" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "panel_usage_monthly" ADD COLUMN "notified" jsonb DEFAULT '[]'::jsonb NOT NULL;