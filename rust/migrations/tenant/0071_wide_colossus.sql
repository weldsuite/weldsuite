ALTER TABLE "mail_domains" ALTER COLUMN "mail_provider" SET DEFAULT 'stalwart';--> statement-breakpoint
ALTER TABLE "mail_domains" ALTER COLUMN "send_provider" SET DEFAULT 'stalwart';--> statement-breakpoint
ALTER TABLE "mail_domains" ALTER COLUMN "receive_provider" SET DEFAULT 'stalwart';--> statement-breakpoint
ALTER TABLE "helpdesk_departments" ADD COLUMN "reply_time" varchar(50);