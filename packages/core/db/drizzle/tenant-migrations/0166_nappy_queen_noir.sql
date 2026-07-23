CREATE TABLE "weldagent_conversations" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"name" varchar(255) DEFAULT 'New Conversation' NOT NULL,
	"module_key" varchar(50),
	"is_pinned" boolean DEFAULT false NOT NULL,
	"last_message_at" timestamp with time zone,
	"message_count" integer DEFAULT 0 NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "weldagent_messages" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"conversation_id" varchar(30) NOT NULL,
	"role" varchar(20) NOT NULL,
	"content" text NOT NULL,
	"tool_invocations" jsonb,
	"form_state" jsonb,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "weldagent_conversations_user_idx" ON "weldagent_conversations" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "weldagent_conversations_last_message_idx" ON "weldagent_conversations" USING btree ("last_message_at");--> statement-breakpoint
CREATE INDEX "weldagent_messages_conversation_idx" ON "weldagent_messages" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "weldagent_messages_created_at_idx" ON "weldagent_messages" USING btree ("created_at");