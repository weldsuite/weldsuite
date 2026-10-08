ALTER TABLE "hr_shifts" ADD COLUMN "work_type" varchar(100);--> statement-breakpoint
ALTER TABLE "hr_shifts" ADD COLUMN "break_starts_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "hr_shifts" ADD COLUMN "break_ends_at" timestamp with time zone;