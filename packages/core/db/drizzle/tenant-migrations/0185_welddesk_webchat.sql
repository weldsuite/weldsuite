DROP TABLE IF EXISTS "desk_conversation_slas" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "desk_workflow_trigger_log" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "desk_workflow_executions" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "desk_workflow_versions" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "desk_workflows" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "desk_ai_resolutions" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "desk_article_embeddings" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "desk_ai_settings" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "desk_linked_objects" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "desk_ticket_type_attributes" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "desk_ticket_states" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "desk_ticket_types" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "desk_teammate_settings" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "desk_teams" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "desk_views" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "desk_macros" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "desk_slas" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "desk_office_hours" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "desk_news" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "desk_conversation_attributes" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "desk_conversation_parts" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "desk_conversations" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "desk_widget_settings" CASCADE;--> statement-breakpoint
CREATE TABLE "desk_conversations" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"conversation_number" integer NOT NULL,
	"title" varchar(500),
	"state" varchar(10) DEFAULT 'open' NOT NULL,
	"channel" varchar(20) DEFAULT 'messenger' NOT NULL,
	"visitor_id" varchar(64),
	"name" varchar(255),
	"email" varchar(255),
	"contact_id" varchar(30),
	"assignee_id" varchar(255),
	"waiting_since" timestamp,
	"last_message_at" timestamp,
	"last_message_preview" varchar(200)
);--> statement-breakpoint
CREATE TABLE "desk_messages" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"conversation_id" varchar(30) NOT NULL,
	"kind" varchar(10) NOT NULL,
	"body" text,
	"author_type" varchar(10) NOT NULL,
	"author_id" varchar(255),
	"attachments" jsonb,
	"metadata" jsonb
);--> statement-breakpoint
CREATE TABLE "desk_visitors" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"last_seen_at" timestamp DEFAULT now() NOT NULL,
	"name" varchar(255),
	"email" varchar(255),
	"widget_id" varchar(40)
);--> statement-breakpoint
CREATE TABLE "desk_widget_settings" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"widget_id" varchar(40) NOT NULL,
	"widget_name" varchar(255),
	"enabled" boolean DEFAULT true NOT NULL,
	"greeting" varchar(500),
	"branding" jsonb,
	"allowed_domains" jsonb
);--> statement-breakpoint
CREATE UNIQUE INDEX "desk_conversations_number_uidx" ON "desk_conversations" USING btree ("conversation_number");--> statement-breakpoint
CREATE INDEX "desk_conversations_state_waiting_idx" ON "desk_conversations" USING btree ("state","waiting_since");--> statement-breakpoint
CREATE INDEX "desk_conversations_state_last_msg_idx" ON "desk_conversations" USING btree ("state","last_message_at");--> statement-breakpoint
CREATE INDEX "desk_conversations_assignee_idx" ON "desk_conversations" USING btree ("assignee_id","state");--> statement-breakpoint
CREATE INDEX "desk_conversations_visitor_idx" ON "desk_conversations" USING btree ("visitor_id");--> statement-breakpoint
CREATE INDEX "desk_conversations_channel_idx" ON "desk_conversations" USING btree ("channel");--> statement-breakpoint
CREATE INDEX "desk_messages_conversation_created_idx" ON "desk_messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "desk_messages_kind_idx" ON "desk_messages" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "desk_messages_author_idx" ON "desk_messages" USING btree ("author_type","author_id");--> statement-breakpoint
CREATE INDEX "desk_visitors_email_idx" ON "desk_visitors" USING btree ("email");--> statement-breakpoint
CREATE INDEX "desk_visitors_widget_idx" ON "desk_visitors" USING btree ("widget_id");--> statement-breakpoint
CREATE UNIQUE INDEX "desk_widget_settings_widget_id_idx" ON "desk_widget_settings" USING btree ("widget_id");
