CREATE TABLE "hr_shift_requests" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"employee_id" varchar(30) NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"work_type" varchar(100),
	"note" text,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"shift_id" varchar(30),
	"requested_by" varchar(255),
	"reviewed_by" varchar(255),
	"reviewed_at" timestamp,
	"review_note" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "hr_shift_requests_employee_start_idx" ON "hr_shift_requests" USING btree ("employee_id","starts_at");--> statement-breakpoint
CREATE INDEX "hr_shift_requests_status_idx" ON "hr_shift_requests" USING btree ("status");