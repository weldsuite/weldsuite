ALTER TABLE "invoices" ADD COLUMN "quote_id" varchar(30);--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "reminder_level" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "last_reminded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "reminders_paused" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "acct_invoices_quote_idx" ON "invoices" USING btree ("quote_id");