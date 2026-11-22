ALTER TABLE "mail_messages" ADD COLUMN "scheduled_for" timestamp;--> statement-breakpoint
ALTER TABLE "mail_messages" ADD COLUMN "send_status" varchar(20);