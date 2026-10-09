CREATE TABLE IF NOT EXISTS "hr_absences" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"employee_id" varchar(30) NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date,
	"first_day" varchar(10) DEFAULT 'full' NOT NULL,
	"note" text,
	"reported_by" varchar(255),
	"recovered_reported_by" varchar(255),
	"recovered_reported_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hr_absences_employee_start_idx" ON "hr_absences" USING btree ("employee_id","start_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hr_absences_end_idx" ON "hr_absences" USING btree ("end_date");