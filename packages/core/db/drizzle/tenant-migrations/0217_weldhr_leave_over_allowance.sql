ALTER TABLE "hr_checklists" ADD COLUMN "anchor_date" date;--> statement-breakpoint
ALTER TABLE "hr_leave_types" ADD COLUMN "over_allowance" varchar(10) DEFAULT 'allow' NOT NULL;