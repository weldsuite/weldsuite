CREATE TABLE "chat_sections" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"name" varchar(255) NOT NULL,
	"position" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_channels" ADD COLUMN "section_id" varchar(30);--> statement-breakpoint
CREATE INDEX "chat_sections_position_idx" ON "chat_sections" USING btree ("position");--> statement-breakpoint
ALTER TABLE "chat_channels" ADD CONSTRAINT "chat_channels_section_id_chat_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."chat_sections"("id") ON DELETE no action ON UPDATE no action;