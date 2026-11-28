ALTER TABLE "journal_entries" ADD COLUMN "reviewed_at" timestamp;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "reviewed_by" varchar(30);