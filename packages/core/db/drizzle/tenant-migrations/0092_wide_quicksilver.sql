CREATE TABLE "chat_message_reads" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"message_id" varchar(30) NOT NULL,
	"channel_id" varchar(30) NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"read_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_message_reads" ADD CONSTRAINT "chat_message_reads_message_id_chat_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."chat_messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_message_reads" ADD CONSTRAINT "chat_message_reads_channel_id_chat_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."chat_channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_message_reads_message_user_idx" ON "chat_message_reads" USING btree ("message_id","user_id");--> statement-breakpoint
CREATE INDEX "chat_message_reads_channel_user_idx" ON "chat_message_reads" USING btree ("channel_id","user_id");--> statement-breakpoint
CREATE INDEX "chat_message_reads_message_idx" ON "chat_message_reads" USING btree ("message_id");