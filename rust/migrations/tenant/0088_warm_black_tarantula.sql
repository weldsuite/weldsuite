CREATE TABLE "chat_reminders" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"channel_id" varchar(30) NOT NULL,
	"message_id" varchar(30) NOT NULL,
	"message_preview" text,
	"remind_at" timestamp NOT NULL,
	"fired_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "chat_reminders" ADD CONSTRAINT "chat_reminders_channel_id_chat_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."chat_channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_reminders" ADD CONSTRAINT "chat_reminders_message_id_chat_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."chat_messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_reminders_user_idx" ON "chat_reminders" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "chat_reminders_remind_at_idx" ON "chat_reminders" USING btree ("remind_at");