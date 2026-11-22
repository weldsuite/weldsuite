ALTER TABLE "meeting_sessions" ADD COLUMN "rtk_session_id" varchar(100);--> statement-breakpoint
ALTER TABLE "meeting_sessions" ADD COLUMN "recording_status" varchar(20);--> statement-breakpoint
ALTER TABLE "meeting_sessions" ADD COLUMN "recording_rtk_id" varchar(100);--> statement-breakpoint
ALTER TABLE "meeting_sessions" ADD COLUMN "recording_video_key" varchar(500);--> statement-breakpoint
ALTER TABLE "meeting_sessions" ADD COLUMN "recording_audio_key" varchar(500);--> statement-breakpoint
ALTER TABLE "meeting_sessions" ADD COLUMN "recording_size_bytes" bigint;--> statement-breakpoint
ALTER TABLE "meeting_sessions" ADD COLUMN "recording_duration_seconds" integer;--> statement-breakpoint
ALTER TABLE "meeting_sessions" ADD COLUMN "recording_ready_at" timestamp;--> statement-breakpoint
ALTER TABLE "meeting_sessions" ADD COLUMN "recording_error" text;--> statement-breakpoint
ALTER TABLE "meeting_sessions" ADD COLUMN "recording_parts" jsonb;--> statement-breakpoint
ALTER TABLE "meeting_sessions" ADD COLUMN "ai_transcribe_requested" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "meeting_sessions" ADD COLUMN "ai_summarize_requested" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "meeting_sessions" ADD COLUMN "ai_language" varchar(10);--> statement-breakpoint
ALTER TABLE "meeting_sessions" ADD COLUMN "transcription_credits_charged" integer;--> statement-breakpoint
ALTER TABLE "meeting_sessions" ADD COLUMN "summary_status" varchar(20);--> statement-breakpoint
ALTER TABLE "meeting_sessions" ADD COLUMN "summary_text" text;--> statement-breakpoint
ALTER TABLE "meeting_sessions" ADD COLUMN "summary_format" varchar(20);--> statement-breakpoint
ALTER TABLE "meeting_sessions" ADD COLUMN "summary_source" varchar(20);--> statement-breakpoint
ALTER TABLE "meeting_sessions" ADD COLUMN "summary_generated_at" timestamp;--> statement-breakpoint
ALTER TABLE "meeting_sessions" ADD COLUMN "summary_error" text;--> statement-breakpoint
ALTER TABLE "meeting_sessions" ADD COLUMN "summary_credits_charged" integer;--> statement-breakpoint
CREATE INDEX "meeting_sessions_recording_status_idx" ON "meeting_sessions" USING btree ("recording_status");