CREATE TABLE "hr_announcement_reads" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"announcement_id" varchar(30) NOT NULL,
	"employee_id" varchar(30) NOT NULL,
	"read_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_announcements" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"title" varchar(200) NOT NULL,
	"body" text NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"department_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	"notified_at" timestamp with time zone,
	"created_by" varchar(255),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "hr_open_shifts" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"company_id" varchar(30),
	"department_id" varchar(30),
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"work_type" varchar(100),
	"break_starts_at" timestamp with time zone,
	"break_ends_at" timestamp with time zone,
	"notes" text,
	"spots" integer DEFAULT 1 NOT NULL,
	"status" varchar(20) DEFAULT 'open' NOT NULL,
	"created_by" varchar(255),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hr_work_locations" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"name" varchar(160) NOT NULL,
	"address" text,
	"latitude" double precision NOT NULL,
	"longitude" double precision NOT NULL,
	"radius_meters" integer DEFAULT 150 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "hr_attendance_records" ADD COLUMN "clock_in_location_id" varchar(30);--> statement-breakpoint
ALTER TABLE "hr_attendance_records" ADD COLUMN "clock_in_latitude" double precision;--> statement-breakpoint
ALTER TABLE "hr_attendance_records" ADD COLUMN "clock_in_longitude" double precision;--> statement-breakpoint
ALTER TABLE "hr_attendance_records" ADD COLUMN "clock_out_location_id" varchar(30);--> statement-breakpoint
ALTER TABLE "hr_attendance_records" ADD COLUMN "clock_out_latitude" double precision;--> statement-breakpoint
ALTER TABLE "hr_attendance_records" ADD COLUMN "clock_out_longitude" double precision;--> statement-breakpoint
ALTER TABLE "hr_employees" ADD COLUMN "work_location_ids" jsonb;--> statement-breakpoint
ALTER TABLE "hr_portal_settings" ADD COLUMN "clock_in_requires_location" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "hr_shift_requests" ADD COLUMN "open_shift_id" varchar(30);--> statement-breakpoint
CREATE UNIQUE INDEX "hr_announcement_reads_uidx" ON "hr_announcement_reads" USING btree ("announcement_id","employee_id");--> statement-breakpoint
CREATE INDEX "hr_announcement_reads_employee_idx" ON "hr_announcement_reads" USING btree ("employee_id");--> statement-breakpoint
CREATE INDEX "hr_announcements_published_idx" ON "hr_announcements" USING btree ("published_at");--> statement-breakpoint
CREATE INDEX "hr_open_shifts_start_idx" ON "hr_open_shifts" USING btree ("starts_at");--> statement-breakpoint
CREATE INDEX "hr_open_shifts_status_idx" ON "hr_open_shifts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "hr_shift_requests_open_shift_idx" ON "hr_shift_requests" USING btree ("open_shift_id");