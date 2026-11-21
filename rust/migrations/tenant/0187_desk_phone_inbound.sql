CREATE TABLE "desk_voice_agents" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"name" varchar(255) NOT NULL,
	"system_prompt" text NOT NULL,
	"greeting" text,
	"telnyx_assistant_id" varchar(100),
	"enabled" boolean DEFAULT true NOT NULL,
	"forward_to_e164" varchar(50),
	"model" varchar(100),
	"voice" varchar(100),
	"deleted_at" timestamp
);--> statement-breakpoint
CREATE TABLE "desk_phone_routes" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"voip_phone_number_id" varchar(30) NOT NULL,
	"action" varchar(20) DEFAULT 'hangup' NOT NULL,
	"voice_agent_id" varchar(30),
	"forward_to_e164" varchar(50),
	"schedule" jsonb
);--> statement-breakpoint
ALTER TABLE "voip_calls" ADD COLUMN "desk_conversation_id" varchar(30);--> statement-breakpoint
ALTER TABLE "desk_visitors" ADD COLUMN "phone" varchar(50);--> statement-breakpoint
CREATE INDEX "desk_voice_agents_enabled_idx" ON "desk_voice_agents" USING btree ("enabled");--> statement-breakpoint
CREATE INDEX "desk_voice_agents_telnyx_idx" ON "desk_voice_agents" USING btree ("telnyx_assistant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "desk_phone_routes_number_uidx" ON "desk_phone_routes" USING btree ("voip_phone_number_id");--> statement-breakpoint
CREATE INDEX "desk_phone_routes_action_idx" ON "desk_phone_routes" USING btree ("action");--> statement-breakpoint
CREATE INDEX "desk_phone_routes_agent_idx" ON "desk_phone_routes" USING btree ("voice_agent_id");--> statement-breakpoint
CREATE INDEX "voip_calls_desk_conversation_idx" ON "voip_calls" USING btree ("desk_conversation_id");--> statement-breakpoint
CREATE INDEX "desk_visitors_phone_idx" ON "desk_visitors" USING btree ("phone");
