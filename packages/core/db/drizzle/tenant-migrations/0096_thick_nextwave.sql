CREATE TABLE "support_channels" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"last_message_at" timestamp,
	"last_message_preview" text,
	"message_count" integer DEFAULT 0 NOT NULL,
	"member_count" integer DEFAULT 0 NOT NULL,
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "support_channel_members" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"channel_id" varchar(30) NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"role" varchar(20) DEFAULT 'member' NOT NULL,
	"joined_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_messages" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"channel_id" varchar(30) NOT NULL,
	"author_id" varchar(255) NOT NULL,
	"author_name" varchar(255) NOT NULL,
	"author_avatar" varchar(500),
	"author_type" varchar(20) DEFAULT 'customer' NOT NULL,
	"content" text NOT NULL,
	"html_content" text,
	"is_edited" boolean DEFAULT false NOT NULL,
	"attachments" jsonb,
	"metadata" jsonb
);
--> statement-breakpoint
ALTER TABLE "support_channel_members" ADD CONSTRAINT "support_channel_members_channel_id_support_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."support_channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_channel_id_support_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."support_channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "support_channels_status_idx" ON "support_channels" USING btree ("status");--> statement-breakpoint
CREATE INDEX "support_channels_last_message_at_idx" ON "support_channels" USING btree ("last_message_at");--> statement-breakpoint
CREATE UNIQUE INDEX "support_channel_members_unique_idx" ON "support_channel_members" USING btree ("channel_id","user_id");--> statement-breakpoint
CREATE INDEX "support_channel_members_channel_idx" ON "support_channel_members" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "support_channel_members_user_idx" ON "support_channel_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "support_messages_channel_created_idx" ON "support_messages" USING btree ("channel_id","created_at");--> statement-breakpoint
CREATE INDEX "support_messages_channel_idx" ON "support_messages" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "support_messages_author_idx" ON "support_messages" USING btree ("author_id");