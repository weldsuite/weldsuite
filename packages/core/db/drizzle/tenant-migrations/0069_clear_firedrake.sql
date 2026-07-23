ALTER TABLE "mail_domains" ALTER COLUMN "mail_provider" SET DEFAULT 'elasticemail';--> statement-breakpoint
ALTER TABLE "mail_domains" ALTER COLUMN "send_provider" SET DEFAULT 'elasticemail';--> statement-breakpoint
ALTER TABLE "mail_domains" ALTER COLUMN "receive_provider" SET DEFAULT 'elasticemail';