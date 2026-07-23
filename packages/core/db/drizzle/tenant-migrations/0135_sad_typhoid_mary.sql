CREATE TABLE "meeting_session_waitlist" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"meeting_id" varchar(30) NOT NULL,
	"session_id" varchar(30),
	"name" varchar(255) NOT NULL,
	"email" varchar(320) NOT NULL,
	"contact_id" varchar(30),
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"requested_at" timestamp DEFAULT now() NOT NULL,
	"decided_at" timestamp,
	"decided_by" varchar(255),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "host_management" boolean DEFAULT true;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "allow_screen_share" boolean DEFAULT true;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "allow_microphone" boolean DEFAULT true;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "allow_video" boolean DEFAULT true;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "allow_hand_raise" boolean DEFAULT true;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "allow_reactions" boolean DEFAULT true;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "allow_annotations" boolean DEFAULT true;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "allow_virtual_backgrounds" boolean DEFAULT true;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "allow_participant_record" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "allow_third_party_access" boolean DEFAULT true;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "noise_cancellation" boolean DEFAULT true;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "enable_captions" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "auto_record" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "host_must_join_first" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "lock_after_start" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "auto_end_on_inactivity" boolean DEFAULT true;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "auto_end_inactivity_minutes" integer DEFAULT 10;--> statement-breakpoint
CREATE INDEX "meeting_waitlist_meeting_idx" ON "meeting_session_waitlist" USING btree ("meeting_id");--> statement-breakpoint
CREATE INDEX "meeting_waitlist_status_idx" ON "meeting_session_waitlist" USING btree ("status");--> statement-breakpoint
CREATE INDEX "meeting_waitlist_email_idx" ON "meeting_session_waitlist" USING btree ("email");