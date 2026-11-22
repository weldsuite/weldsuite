CREATE TABLE "meeting_messages" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"meeting_id" varchar(30) NOT NULL,
	"author_id" varchar(255) NOT NULL,
	"author_name" varchar(255) NOT NULL,
	"author_avatar" varchar(500),
	"content" text NOT NULL,
	"type" varchar(20) DEFAULT 'message' NOT NULL,
	"attachments" jsonb,
	"has_attachments" boolean DEFAULT false NOT NULL,
	"metadata" jsonb
);
--> statement-breakpoint
ALTER TABLE "meeting_messages" ADD CONSTRAINT "meeting_messages_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "meeting_messages_meeting_created_idx" ON "meeting_messages" USING btree ("meeting_id","created_at");--> statement-breakpoint
CREATE INDEX "meeting_messages_author_idx" ON "meeting_messages" USING btree ("author_id");