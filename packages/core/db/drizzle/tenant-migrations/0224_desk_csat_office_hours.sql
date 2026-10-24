ALTER TABLE "desk_conversations" ADD COLUMN "rating" integer;--> statement-breakpoint
ALTER TABLE "desk_conversations" ADD COLUMN "rating_comment" text;--> statement-breakpoint
ALTER TABLE "desk_conversations" ADD COLUMN "rated_at" timestamp;--> statement-breakpoint
ALTER TABLE "desk_widget_settings" ADD COLUMN "office_hours" jsonb;--> statement-breakpoint
ALTER TABLE "desk_widget_settings" ADD COLUMN "timezone" varchar(64);--> statement-breakpoint
ALTER TABLE "desk_widget_settings" ADD COLUMN "away_message" varchar(1000);--> statement-breakpoint
ALTER TABLE "desk_widget_settings" ADD COLUMN "expected_reply_time" varchar(20);