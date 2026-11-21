CREATE TABLE "chat_drafts" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(30) NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"channel_id" varchar(30),
	"thread_parent_message_id" varchar(30),
	"content" text NOT NULL,
	"attachments" jsonb,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "chat_drafts_user_workspace_idx" ON "chat_drafts" USING btree ("user_id","workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_drafts_location_idx" ON "chat_drafts" USING btree ("user_id","channel_id","thread_parent_message_id");