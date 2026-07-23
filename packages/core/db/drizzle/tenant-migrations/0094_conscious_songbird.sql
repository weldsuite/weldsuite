CREATE TABLE "files" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"file_name" varchar(500) NOT NULL,
	"original_name" varchar(500),
	"mime_type" varchar(255) NOT NULL,
	"file_size" integer NOT NULL,
	"file_type" varchar(50) DEFAULT 'file' NOT NULL,
	"storage_path" varchar(1000) NOT NULL,
	"file_key" varchar(1000),
	"bucket" varchar(255),
	"url" varchar(1000),
	"thumbnail_url" varchar(1000),
	"storage_provider" varchar(50) DEFAULT 'r2' NOT NULL,
	"folder_id" varchar(255),
	"uploaded_by_id" varchar(255),
	"is_public" boolean DEFAULT false NOT NULL,
	"is_starred" boolean DEFAULT false NOT NULL,
	"entity_type" varchar(100),
	"entity_id" varchar(255),
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "folders" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"name" varchar(500) NOT NULL,
	"parent_id" varchar(255),
	"color" varchar(50),
	"icon" varchar(50),
	"created_by_id" varchar(255),
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "calendars" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"name" varchar(255) NOT NULL,
	"description" varchar(500),
	"color" varchar(20),
	"owner_id" varchar(255) NOT NULL,
	"is_default" boolean DEFAULT false,
	"is_active" boolean DEFAULT true
);
--> statement-breakpoint
CREATE TABLE "calendar_shares" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"calendar_id" varchar(30) NOT NULL,
	"shared_with_id" varchar(255) NOT NULL,
	"permission" varchar(20) DEFAULT 'view' NOT NULL,
	"shared_by_id" varchar(255) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calendar_events" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
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
	"customer_id" varchar(30),
	"contact_id" varchar(30),
	"notes" text,
	"attachments" jsonb,
	"tags" jsonb,
	"custom_fields" jsonb
);
--> statement-breakpoint
CREATE TABLE "calendar_booking_pages" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
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
	"confirmation_message" text
);
--> statement-breakpoint
CREATE TABLE "calendar_bookings" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"booking_page_id" varchar(30) NOT NULL,
	"calendar_event_id" varchar(30),
	"booker_name" varchar(255) NOT NULL,
	"booker_email" varchar(255) NOT NULL,
	"start_time" timestamp NOT NULL,
	"end_time" timestamp NOT NULL,
	"status" varchar(20) DEFAULT 'confirmed' NOT NULL,
	"answers" jsonb,
	"notes" text,
	"cancelled_at" timestamp,
	"cancel_reason" text
);
--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "files_folder_idx" ON "files" USING btree ("folder_id");--> statement-breakpoint
CREATE INDEX "files_uploaded_by_idx" ON "files" USING btree ("uploaded_by_id");--> statement-breakpoint
CREATE INDEX "files_file_type_idx" ON "files" USING btree ("file_type");--> statement-breakpoint
CREATE INDEX "files_entity_idx" ON "files" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "folders_parent_idx" ON "folders" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "folders_created_by_idx" ON "folders" USING btree ("created_by_id");--> statement-breakpoint
CREATE INDEX "calendars_owner_idx" ON "calendars" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "calendar_shares_calendar_idx" ON "calendar_shares" USING btree ("calendar_id");--> statement-breakpoint
CREATE INDEX "calendar_shares_shared_with_idx" ON "calendar_shares" USING btree ("shared_with_id");--> statement-breakpoint
CREATE INDEX "calendar_shares_calendar_user_idx" ON "calendar_shares" USING btree ("calendar_id","shared_with_id");--> statement-breakpoint
CREATE INDEX "calendar_events_calendar_idx" ON "calendar_events" USING btree ("calendar_id");--> statement-breakpoint
CREATE INDEX "calendar_events_type_idx" ON "calendar_events" USING btree ("type");--> statement-breakpoint
CREATE INDEX "calendar_events_organizer_idx" ON "calendar_events" USING btree ("organizer_id");--> statement-breakpoint
CREATE INDEX "calendar_events_start_time_idx" ON "calendar_events" USING btree ("start_time");--> statement-breakpoint
CREATE INDEX "calendar_events_status_idx" ON "calendar_events" USING btree ("status");--> statement-breakpoint
CREATE INDEX "calendar_events_customer_idx" ON "calendar_events" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "calendar_events_contact_idx" ON "calendar_events" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "calendar_events_recurrence_idx" ON "calendar_events" USING btree ("recurrence_id");--> statement-breakpoint
CREATE INDEX "calendar_booking_pages_owner_idx" ON "calendar_booking_pages" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "calendar_booking_pages_slug_idx" ON "calendar_booking_pages" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "calendar_booking_pages_active_idx" ON "calendar_booking_pages" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "calendar_bookings_page_idx" ON "calendar_bookings" USING btree ("booking_page_id");--> statement-breakpoint
CREATE INDEX "calendar_bookings_email_idx" ON "calendar_bookings" USING btree ("booker_email");--> statement-breakpoint
CREATE INDEX "calendar_bookings_start_time_idx" ON "calendar_bookings" USING btree ("start_time");--> statement-breakpoint
CREATE INDEX "calendar_bookings_status_idx" ON "calendar_bookings" USING btree ("status");