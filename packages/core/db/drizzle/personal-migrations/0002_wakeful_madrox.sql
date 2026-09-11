CREATE TABLE "personal_calendars" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"personal_account_id" varchar(30) NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" varchar(500),
	"color" varchar(20),
	"owner_id" varchar(255) NOT NULL,
	"is_default" boolean DEFAULT false,
	"is_active" boolean DEFAULT true
);
--> statement-breakpoint
CREATE TABLE "personal_calendar_events" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"personal_account_id" varchar(30) NOT NULL,
	"title" varchar(255) NOT NULL,
	"description" text,
	"type" varchar(30) NOT NULL,
	"start_time" timestamp NOT NULL,
	"end_time" timestamp,
	"all_day" boolean DEFAULT false,
	"timezone" varchar(50),
	"location" varchar(500),
	"is_virtual" boolean DEFAULT false,
	"meeting_url" varchar(1000),
	"status" varchar(20) DEFAULT 'confirmed' NOT NULL,
	"priority" varchar(10) DEFAULT 'normal',
	"color" varchar(20),
	"recurrence_rule" varchar(500),
	"recurrence_id" varchar(30),
	"calendar_id" varchar(30) NOT NULL,
	"organizer_id" varchar(255) NOT NULL,
	"attendees" jsonb,
	"reminders" jsonb,
	"notes" text,
	"attachments" jsonb,
	"tags" jsonb,
	"custom_fields" jsonb
);
--> statement-breakpoint
CREATE TABLE "personal_calendar_booking_pages" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"personal_account_id" varchar(30) NOT NULL,
	"name" varchar(255) NOT NULL,
	"slug" varchar(100) NOT NULL,
	"description" text,
	"owner_id" varchar(255) NOT NULL,
	"duration" integer NOT NULL,
	"buffer_before" integer DEFAULT 0,
	"buffer_after" integer DEFAULT 0,
	"color" varchar(20),
	"is_active" boolean DEFAULT true,
	"location_type" varchar(20),
	"location_value" varchar(500),
	"availability" jsonb NOT NULL,
	"questions" jsonb,
	"min_notice" integer DEFAULT 60,
	"max_advance" integer DEFAULT 60,
	"confirmation_message" text,
	"timezone" varchar(100) DEFAULT 'UTC' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "personal_calendar_bookings" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"personal_account_id" varchar(30) NOT NULL,
	"booking_page_id" varchar(30) NOT NULL,
	"calendar_event_id" varchar(30),
	"booker_name" varchar(255) NOT NULL,
	"booker_email" varchar(255) NOT NULL,
	"start_time" timestamp NOT NULL,
	"end_time" timestamp NOT NULL,
	"status" varchar(20) DEFAULT 'confirmed' NOT NULL,
	"answers" jsonb,
	"notes" text,
	"guests" jsonb,
	"timezone" varchar(100),
	"cancelled_at" timestamp,
	"cancel_reason" text
);
--> statement-breakpoint
CREATE INDEX "personal_calendars_personal_account_idx" ON "personal_calendars" USING btree ("personal_account_id");--> statement-breakpoint
CREATE INDEX "personal_calendars_owner_idx" ON "personal_calendars" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "personal_calendar_events_personal_account_idx" ON "personal_calendar_events" USING btree ("personal_account_id");--> statement-breakpoint
CREATE INDEX "personal_calendar_events_calendar_idx" ON "personal_calendar_events" USING btree ("calendar_id");--> statement-breakpoint
CREATE INDEX "personal_calendar_events_type_idx" ON "personal_calendar_events" USING btree ("type");--> statement-breakpoint
CREATE INDEX "personal_calendar_events_organizer_idx" ON "personal_calendar_events" USING btree ("organizer_id");--> statement-breakpoint
CREATE INDEX "personal_calendar_events_start_time_idx" ON "personal_calendar_events" USING btree ("start_time");--> statement-breakpoint
CREATE INDEX "personal_calendar_events_status_idx" ON "personal_calendar_events" USING btree ("status");--> statement-breakpoint
CREATE INDEX "personal_calendar_events_recurrence_idx" ON "personal_calendar_events" USING btree ("recurrence_id");--> statement-breakpoint
CREATE INDEX "personal_calendar_booking_pages_personal_account_idx" ON "personal_calendar_booking_pages" USING btree ("personal_account_id");--> statement-breakpoint
CREATE INDEX "personal_calendar_booking_pages_owner_idx" ON "personal_calendar_booking_pages" USING btree ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "personal_calendar_booking_pages_slug_idx" ON "personal_calendar_booking_pages" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "personal_calendar_booking_pages_active_idx" ON "personal_calendar_booking_pages" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "personal_calendar_bookings_personal_account_idx" ON "personal_calendar_bookings" USING btree ("personal_account_id");--> statement-breakpoint
CREATE INDEX "personal_calendar_bookings_page_idx" ON "personal_calendar_bookings" USING btree ("booking_page_id");--> statement-breakpoint
CREATE INDEX "personal_calendar_bookings_email_idx" ON "personal_calendar_bookings" USING btree ("booker_email");--> statement-breakpoint
CREATE INDEX "personal_calendar_bookings_start_time_idx" ON "personal_calendar_bookings" USING btree ("start_time");--> statement-breakpoint
CREATE INDEX "personal_calendar_bookings_status_idx" ON "personal_calendar_bookings" USING btree ("status");