CREATE TABLE "meetings" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"title" varchar(255) NOT NULL,
	"description" text,
	"calendar_event_id" varchar(30),
	"organizer_id" varchar(255) NOT NULL,
	"attendees" jsonb DEFAULT '[]'::jsonb,
	"meeting_type" varchar(20) DEFAULT 'video' NOT NULL,
	"status" varchar(20) DEFAULT 'scheduled' NOT NULL,
	"access_type" varchar(20) DEFAULT 'workspace' NOT NULL,
	"waiting_room" boolean DEFAULT false,
	"allow_recording" boolean DEFAULT true,
	"max_participants" integer,
	"join_code" varchar(50),
	"active_session_id" varchar(30),
	"scheduled_start" timestamp,
	"scheduled_end" timestamp,
	"is_recurring" boolean DEFAULT false,
	"recurrence_rule" varchar(500),
	"parent_meeting_id" varchar(30),
	"tags" jsonb,
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "meeting_sessions" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"meeting_id" varchar(30) NOT NULL,
	"session_type" varchar(20) DEFAULT 'video' NOT NULL,
	"status" varchar(20) DEFAULT 'waiting' NOT NULL,
	"cf_app_id" varchar(100),
	"started_by" varchar(255) NOT NULL,
	"started_by_name" varchar(255) NOT NULL,
	"participants" jsonb DEFAULT '[]'::jsonb,
	"started_at" timestamp,
	"ended_at" timestamp,
	"duration" integer,
	"max_participants" integer DEFAULT 0 NOT NULL,
	"recording_enabled" boolean DEFAULT false,
	"recording_url" text,
	"recording_key" varchar(500),
	"metadata" jsonb
);
--> statement-breakpoint
ALTER TABLE "meeting_sessions" ADD CONSTRAINT "meeting_sessions_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "meetings_organizer_idx" ON "meetings" USING btree ("organizer_id");--> statement-breakpoint
CREATE INDEX "meetings_calendar_event_idx" ON "meetings" USING btree ("calendar_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "meetings_join_code_idx" ON "meetings" USING btree ("join_code");--> statement-breakpoint
CREATE INDEX "meetings_active_session_idx" ON "meetings" USING btree ("active_session_id");--> statement-breakpoint
CREATE INDEX "meetings_status_idx" ON "meetings" USING btree ("status");--> statement-breakpoint
CREATE INDEX "meetings_scheduled_start_idx" ON "meetings" USING btree ("scheduled_start");--> statement-breakpoint
CREATE INDEX "meetings_deleted_at_idx" ON "meetings" USING btree ("deleted_at");--> statement-breakpoint
CREATE INDEX "meetings_parent_meeting_idx" ON "meetings" USING btree ("parent_meeting_id");--> statement-breakpoint
CREATE INDEX "meeting_sessions_meeting_idx" ON "meeting_sessions" USING btree ("meeting_id");--> statement-breakpoint
CREATE INDEX "meeting_sessions_status_idx" ON "meeting_sessions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "meeting_sessions_started_by_idx" ON "meeting_sessions" USING btree ("started_by");--> statement-breakpoint
CREATE INDEX "meeting_sessions_created_at_idx" ON "meeting_sessions" USING btree ("created_at");