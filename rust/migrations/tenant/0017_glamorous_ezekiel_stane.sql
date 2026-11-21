CREATE TABLE "telnyx_calls" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"telnyx_call_control_id" varchar(255),
	"telnyx_call_session_id" varchar(255),
	"telnyx_call_leg_id" varchar(255),
	"direction" varchar(20) NOT NULL,
	"status" varchar(20) DEFAULT 'initiated' NOT NULL,
	"from_number" varchar(50) NOT NULL,
	"to_number" varchar(50) NOT NULL,
	"from_number_formatted" varchar(50),
	"to_number_formatted" varchar(50),
	"initiated_at" timestamp DEFAULT now() NOT NULL,
	"answered_at" timestamp,
	"ended_at" timestamp,
	"duration" integer,
	"is_recorded" boolean DEFAULT false,
	"recording_storage_key" varchar(500),
	"recording_storage_url" text,
	"recording_file_size" integer,
	"recording_duration" integer,
	"transcription_id" varchar(30),
	"transcription_status" varchar(20),
	"customer_id" varchar(30),
	"contact_id" varchar(30),
	"opportunity_id" varchar(30),
	"activity_id" varchar(30),
	"credits_consumed" integer DEFAULT 0,
	"credit_transaction_id" varchar(30),
	"ai_summary" text,
	"ai_sentiment" varchar(20),
	"ai_key_topics" jsonb,
	"ai_action_items" jsonb,
	"ai_analyzed_at" timestamp,
	"hangup_cause" varchar(100),
	"hangup_source" varchar(50),
	"error_message" text,
	"call_quality_score" numeric(3, 2),
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "telnyx_phone_numbers" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"phone_number" varchar(50) NOT NULL,
	"formatted_number" varchar(50),
	"country_code" varchar(5) NOT NULL,
	"number_type" varchar(20) DEFAULT 'local',
	"telnyx_phone_number_id" varchar(255),
	"telnyx_connection_id" varchar(255),
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"workspace_id" varchar(255),
	"assigned_user_id" varchar(255),
	"assigned_at" timestamp,
	"is_default" boolean DEFAULT false,
	"allow_inbound" boolean DEFAULT true,
	"allow_outbound" boolean DEFAULT true,
	"enable_recording" boolean DEFAULT true,
	"display_name" varchar(100),
	"description" text,
	"deleted_at" timestamp,
	CONSTRAINT "telnyx_phone_numbers_phone_number_unique" UNIQUE("phone_number")
);
--> statement-breakpoint
CREATE INDEX "telnyx_calls_workspace_idx" ON "telnyx_calls" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "telnyx_calls_user_idx" ON "telnyx_calls" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "telnyx_calls_status_idx" ON "telnyx_calls" USING btree ("status");--> statement-breakpoint
CREATE INDEX "telnyx_calls_direction_idx" ON "telnyx_calls" USING btree ("direction");--> statement-breakpoint
CREATE INDEX "telnyx_calls_from_number_idx" ON "telnyx_calls" USING btree ("from_number");--> statement-breakpoint
CREATE INDEX "telnyx_calls_to_number_idx" ON "telnyx_calls" USING btree ("to_number");--> statement-breakpoint
CREATE INDEX "telnyx_calls_customer_idx" ON "telnyx_calls" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "telnyx_calls_contact_idx" ON "telnyx_calls" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "telnyx_calls_opportunity_idx" ON "telnyx_calls" USING btree ("opportunity_id");--> statement-breakpoint
CREATE INDEX "telnyx_calls_call_control_idx" ON "telnyx_calls" USING btree ("telnyx_call_control_id");--> statement-breakpoint
CREATE INDEX "telnyx_calls_initiated_at_idx" ON "telnyx_calls" USING btree ("initiated_at");--> statement-breakpoint
CREATE INDEX "telnyx_phone_numbers_workspace_idx" ON "telnyx_phone_numbers" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "telnyx_phone_numbers_user_idx" ON "telnyx_phone_numbers" USING btree ("assigned_user_id");--> statement-breakpoint
CREATE INDEX "telnyx_phone_numbers_status_idx" ON "telnyx_phone_numbers" USING btree ("status");--> statement-breakpoint
CREATE INDEX "telnyx_phone_numbers_country_idx" ON "telnyx_phone_numbers" USING btree ("country_code");--> statement-breakpoint
CREATE INDEX "telnyx_phone_numbers_telnyx_id_idx" ON "telnyx_phone_numbers" USING btree ("telnyx_phone_number_id");