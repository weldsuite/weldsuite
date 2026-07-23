CREATE TABLE "helpdesk_conversation_events" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"conversation_id" varchar(30) NOT NULL,
	"event_type" varchar(60) NOT NULL,
	"initiator" varchar(20) DEFAULT 'system' NOT NULL,
	"actor_id" varchar(255),
	"actor_name" varchar(255),
	"actor_avatar" varchar(500),
	"description" text NOT NULL,
	"data" jsonb,
	"changes" jsonb,
	"is_public" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"related_message_id" varchar(30),
	"related_entity_type" varchar(50),
	"related_entity_id" varchar(30),
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "chat_channels" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"name" varchar(255) NOT NULL,
	"slug" varchar(255) NOT NULL,
	"description" text,
	"topic" text,
	"type" varchar(20) DEFAULT 'public' NOT NULL,
	"icon" varchar(50),
	"created_by" varchar(255),
	"is_archived" boolean DEFAULT false NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"last_message_at" timestamp,
	"last_message_preview" text,
	"message_count" integer DEFAULT 0 NOT NULL,
	"member_count" integer DEFAULT 0 NOT NULL,
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "chat_channel_members" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"channel_id" varchar(30) NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"role" varchar(20) DEFAULT 'member' NOT NULL,
	"last_read_at" timestamp,
	"last_read_message_id" varchar(30),
	"is_muted" boolean DEFAULT false NOT NULL,
	"notification_preference" varchar(20) DEFAULT 'all' NOT NULL,
	"joined_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"channel_id" varchar(30) NOT NULL,
	"author_id" varchar(255) NOT NULL,
	"author_name" varchar(255) NOT NULL,
	"author_avatar" varchar(500),
	"content" text NOT NULL,
	"html_content" text,
	"type" varchar(20) DEFAULT 'message' NOT NULL,
	"parent_id" varchar(30),
	"thread_reply_count" integer DEFAULT 0 NOT NULL,
	"thread_last_reply_at" timestamp,
	"thread_participant_ids" jsonb,
	"is_edited" boolean DEFAULT false NOT NULL,
	"edited_at" timestamp,
	"is_pinned" boolean DEFAULT false NOT NULL,
	"pinned_at" timestamp,
	"pinned_by" varchar(255),
	"attachments" jsonb,
	"has_attachments" boolean DEFAULT false NOT NULL,
	"reactions" jsonb,
	"mentions" jsonb,
	"mentions_everyone" boolean DEFAULT false NOT NULL,
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "chat_bookmarks" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"message_id" varchar(30) NOT NULL,
	"channel_id" varchar(30) NOT NULL,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "chat_user_status" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"status" varchar(20) DEFAULT 'online' NOT NULL,
	"status_text" varchar(255),
	"status_emoji" varchar(50),
	"status_expires_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "helpdesk_conversations" ADD COLUMN "ticket_number" varchar(50);--> statement-breakpoint
ALTER TABLE "helpdesk_conversations" ADD COLUMN "is_ticket" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "helpdesk_conversations" ADD COLUMN "category" varchar(50);--> statement-breakpoint
ALTER TABLE "helpdesk_conversations" ADD COLUMN "subcategory" varchar(100);--> statement-breakpoint
ALTER TABLE "helpdesk_conversations" ADD COLUMN "ticket_type" varchar(30);--> statement-breakpoint
ALTER TABLE "helpdesk_conversations" ADD COLUMN "ticket_type_id" varchar(30);--> statement-breakpoint
ALTER TABLE "helpdesk_conversations" ADD COLUMN "severity" varchar(20);--> statement-breakpoint
ALTER TABLE "helpdesk_conversations" ADD COLUMN "sla_id" varchar(30);--> statement-breakpoint
ALTER TABLE "helpdesk_conversations" ADD COLUMN "response_deadline" timestamp;--> statement-breakpoint
ALTER TABLE "helpdesk_conversations" ADD COLUMN "resolution_deadline" timestamp;--> statement-breakpoint
ALTER TABLE "helpdesk_conversations" ADD COLUMN "sla_status" varchar(20);--> statement-breakpoint
ALTER TABLE "helpdesk_conversations" ADD COLUMN "breached_at" timestamp;--> statement-breakpoint
ALTER TABLE "helpdesk_conversations" ADD COLUMN "first_response_at" timestamp;--> statement-breakpoint
ALTER TABLE "helpdesk_conversations" ADD COLUMN "resolved_at" timestamp;--> statement-breakpoint
ALTER TABLE "helpdesk_conversations" ADD COLUMN "closed_at" timestamp;--> statement-breakpoint
ALTER TABLE "helpdesk_conversations" ADD COLUMN "reopened_at" timestamp;--> statement-breakpoint
ALTER TABLE "helpdesk_conversations" ADD COLUMN "response_time" integer;--> statement-breakpoint
ALTER TABLE "helpdesk_conversations" ADD COLUMN "resolution_time" integer;--> statement-breakpoint
ALTER TABLE "helpdesk_conversations" ADD COLUMN "satisfaction_rating" integer;--> statement-breakpoint
ALTER TABLE "helpdesk_conversations" ADD COLUMN "satisfaction_comment" text;--> statement-breakpoint
ALTER TABLE "helpdesk_conversations" ADD COLUMN "custom_fields" jsonb;--> statement-breakpoint
ALTER TABLE "helpdesk_conversations" ADD COLUMN "parent_conversation_id" varchar(30);--> statement-breakpoint
ALTER TABLE "helpdesk_conversations" ADD COLUMN "merged_conversation_ids" jsonb;--> statement-breakpoint
ALTER TABLE "helpdesk_conversations" ADD COLUMN "is_escalated" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "helpdesk_conversations" ADD COLUMN "source_email" varchar(255);--> statement-breakpoint
ALTER TABLE "helpdesk_conversations" ADD COLUMN "source_url" varchar(500);--> statement-breakpoint
ALTER TABLE "helpdesk_conversation_messages" ADD COLUMN "blocks" jsonb;--> statement-breakpoint
ALTER TABLE "helpdesk_conversation_messages" ADD COLUMN "block_responses" jsonb;--> statement-breakpoint
ALTER TABLE "helpdesk_conversation_messages" ADD COLUMN "email_message_id" varchar(255);--> statement-breakpoint
ALTER TABLE "helpdesk_conversation_messages" ADD COLUMN "in_reply_to" varchar(255);--> statement-breakpoint
ALTER TABLE "helpdesk_conversation_messages" ADD COLUMN "cc" jsonb;--> statement-breakpoint
ALTER TABLE "helpdesk_conversation_messages" ADD COLUMN "bcc" jsonb;--> statement-breakpoint
ALTER TABLE "helpdesk_conversation_messages" ADD COLUMN "subject" varchar(500);--> statement-breakpoint
ALTER TABLE "helpdesk_conversation_events" ADD CONSTRAINT "helpdesk_conversation_events_conversation_id_helpdesk_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."helpdesk_conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_channel_members" ADD CONSTRAINT "chat_channel_members_channel_id_chat_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."chat_channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_channel_id_chat_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."chat_channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_bookmarks" ADD CONSTRAINT "chat_bookmarks_message_id_chat_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."chat_messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_bookmarks" ADD CONSTRAINT "chat_bookmarks_channel_id_chat_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."chat_channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "hd_conv_events_conversation_created_idx" ON "helpdesk_conversation_events" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "hd_conv_events_conversation_type_idx" ON "helpdesk_conversation_events" USING btree ("conversation_id","event_type");--> statement-breakpoint
CREATE INDEX "hd_conv_events_type_created_idx" ON "helpdesk_conversation_events" USING btree ("event_type","created_at");--> statement-breakpoint
CREATE INDEX "hd_conv_events_actor_idx" ON "helpdesk_conversation_events" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "hd_conv_events_public_idx" ON "helpdesk_conversation_events" USING btree ("conversation_id","is_public","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_channels_slug_idx" ON "chat_channels" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "chat_channels_type_idx" ON "chat_channels" USING btree ("type");--> statement-breakpoint
CREATE INDEX "chat_channels_is_archived_idx" ON "chat_channels" USING btree ("is_archived");--> statement-breakpoint
CREATE INDEX "chat_channels_last_message_at_idx" ON "chat_channels" USING btree ("last_message_at");--> statement-breakpoint
CREATE INDEX "chat_channels_created_by_idx" ON "chat_channels" USING btree ("created_by");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_channel_members_unique_idx" ON "chat_channel_members" USING btree ("channel_id","user_id");--> statement-breakpoint
CREATE INDEX "chat_channel_members_channel_idx" ON "chat_channel_members" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "chat_channel_members_user_idx" ON "chat_channel_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "chat_messages_channel_created_idx" ON "chat_messages" USING btree ("channel_id","created_at");--> statement-breakpoint
CREATE INDEX "chat_messages_channel_idx" ON "chat_messages" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "chat_messages_author_idx" ON "chat_messages" USING btree ("author_id");--> statement-breakpoint
CREATE INDEX "chat_messages_parent_idx" ON "chat_messages" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "chat_messages_is_pinned_idx" ON "chat_messages" USING btree ("is_pinned");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_bookmarks_unique_idx" ON "chat_bookmarks" USING btree ("user_id","message_id");--> statement-breakpoint
CREATE INDEX "chat_bookmarks_user_idx" ON "chat_bookmarks" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_user_status_user_idx" ON "chat_user_status" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "helpdesk_conversations_is_ticket_idx" ON "helpdesk_conversations" USING btree ("is_ticket");--> statement-breakpoint
CREATE INDEX "helpdesk_conversations_ticket_number_idx" ON "helpdesk_conversations" USING btree ("ticket_number");--> statement-breakpoint
CREATE INDEX "helpdesk_conversations_sla_status_idx" ON "helpdesk_conversations" USING btree ("sla_status");--> statement-breakpoint
CREATE INDEX "helpdesk_conversations_category_idx" ON "helpdesk_conversations" USING btree ("category");--> statement-breakpoint
CREATE INDEX "helpdesk_conversations_created_at_idx" ON "helpdesk_conversations" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "helpdesk_conversations_status_created_idx" ON "helpdesk_conversations" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "helpdesk_conversations_assignee_status_idx" ON "helpdesk_conversations" USING btree ("assignee_id","status");--> statement-breakpoint
CREATE INDEX "helpdesk_conv_messages_conv_created_idx" ON "helpdesk_conversation_messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
ALTER TABLE "helpdesk_conversations" DROP COLUMN "ticket_id";