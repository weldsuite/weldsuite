ALTER TABLE "chat_channels" ADD COLUMN "threads_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_channels" ADD COLUMN "attachments_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_channels" ADD COLUMN "reactions_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_channels" ADD COLUMN "slow_mode_seconds" integer DEFAULT 0 NOT NULL;