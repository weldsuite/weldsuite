CREATE TABLE "chat_calls" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"channel_id" varchar(30) NOT NULL,
	"call_type" varchar(20) DEFAULT 'voice' NOT NULL,
	"status" varchar(20) DEFAULT 'ringing' NOT NULL,
	"cf_app_id" varchar(100),
	"initiator_id" varchar(255) NOT NULL,
	"initiator_name" varchar(255) NOT NULL,
	"participants" jsonb DEFAULT '[]'::jsonb,
	"started_at" timestamp,
	"ended_at" timestamp,
	"duration" integer,
	"start_message_id" varchar(30),
	"end_message_id" varchar(30),
	"max_participants" integer DEFAULT 0 NOT NULL,
	"metadata" jsonb
);
--> statement-breakpoint
ALTER TABLE "chat_calls" ADD CONSTRAINT "chat_calls_channel_id_chat_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."chat_channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_calls_channel_idx" ON "chat_calls" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "chat_calls_status_idx" ON "chat_calls" USING btree ("status");--> statement-breakpoint
CREATE INDEX "chat_calls_initiator_idx" ON "chat_calls" USING btree ("initiator_id");--> statement-breakpoint
CREATE INDEX "chat_calls_created_at_idx" ON "chat_calls" USING btree ("created_at");