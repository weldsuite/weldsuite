ALTER TABLE "voip_calls" ALTER COLUMN "provider" SET DEFAULT 'telnyx';--> statement-breakpoint
ALTER TABLE "voip_phone_numbers" ALTER COLUMN "provider" SET DEFAULT 'telnyx';--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "chat_channel_id" varchar(30);