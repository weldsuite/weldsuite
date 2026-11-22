ALTER TABLE "mail_messages" ADD COLUMN "threats" jsonb;--> statement-breakpoint
ALTER TABLE "mail_attachments" ADD COLUMN "scan_status" varchar(20);--> statement-breakpoint
ALTER TABLE "mail_attachments" ADD COLUMN "scan_signature" varchar(255);--> statement-breakpoint
ALTER TABLE "mail_attachments" ADD COLUMN "scanned_at" timestamp;--> statement-breakpoint
CREATE INDEX "mail_attachments_scan_pending_idx" ON "mail_attachments" USING btree ("created_at") WHERE "mail_attachments"."scan_status" = 'pending';