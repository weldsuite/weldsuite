CREATE TABLE "helpdesk_report_schedules" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"name" varchar(255) NOT NULL,
	"report_id" varchar(30),
	"range" varchar(30) DEFAULT 'last_7_days' NOT NULL,
	"frequency" varchar(10) NOT NULL,
	"day_of_week" integer,
	"day_of_month" integer,
	"hour" integer DEFAULT 8 NOT NULL,
	"timezone" varchar(64) DEFAULT 'UTC' NOT NULL,
	"recipients" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"attach_csv" boolean DEFAULT true NOT NULL,
	"locale" varchar(5) DEFAULT 'en' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by_id" varchar(255),
	"next_run_at" timestamp,
	"last_run_at" timestamp,
	"last_status" varchar(20),
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE "desk_phone_agents" (
	"user_id" varchar(255) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"telnyx_credential_id" varchar(100),
	"sip_username" varchar(255),
	"available" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "desk_phone_call_legs" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"call_id" varchar(30) NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"provider_call_id" varchar(255),
	"status" varchar(20) DEFAULT 'ringing' NOT NULL,
	"ended_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "audit_log_streams" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"name" varchar(255) NOT NULL,
	"type" varchar(20) NOT NULL,
	"url" text NOT NULL,
	"token_encrypted" text,
	"settings" jsonb,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"cursor_created_at" timestamp,
	"cursor_id" varchar(30),
	"last_delivered_at" timestamp,
	"last_attempt_at" timestamp,
	"last_error" text,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"delivered_count" integer DEFAULT 0 NOT NULL,
	"created_by_id" varchar(255)
);
--> statement-breakpoint
ALTER TABLE "voip_calls" ADD COLUMN "queue_entered_at" timestamp;--> statement-breakpoint
ALTER TABLE "voip_calls" ADD COLUMN "agent_answered_at" timestamp;--> statement-breakpoint
ALTER TABLE "voip_calls" ADD COLUMN "answered_by_user_id" varchar(255);--> statement-breakpoint
ALTER TABLE "voip_calls" ADD COLUMN "outcome" varchar(20);--> statement-breakpoint
ALTER TABLE "voip_calls" ADD COLUMN "department_id" varchar(30);--> statement-breakpoint
ALTER TABLE "desk_phone_routes" ADD COLUMN "options" jsonb;--> statement-breakpoint
CREATE INDEX "helpdesk_report_schedules_due_idx" ON "helpdesk_report_schedules" USING btree ("enabled","next_run_at");--> statement-breakpoint
CREATE INDEX "helpdesk_report_schedules_report_idx" ON "helpdesk_report_schedules" USING btree ("report_id");--> statement-breakpoint
CREATE INDEX "desk_phone_call_legs_call_idx" ON "desk_phone_call_legs" USING btree ("call_id");--> statement-breakpoint
CREATE INDEX "desk_phone_call_legs_user_status_idx" ON "desk_phone_call_legs" USING btree ("user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "desk_phone_call_legs_ringing_uidx" ON "desk_phone_call_legs" USING btree ("call_id","user_id") WHERE "desk_phone_call_legs"."status" = 'ringing';--> statement-breakpoint
CREATE INDEX "audit_log_streams_status_idx" ON "audit_log_streams" USING btree ("status");--> statement-breakpoint
CREATE INDEX "voip_calls_queue_entered_at_idx" ON "voip_calls" USING btree ("queue_entered_at");