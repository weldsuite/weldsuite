CREATE TABLE "chat_channel_role_links" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"channel_id" varchar(30) NOT NULL,
	"role_id" varchar(30) NOT NULL,
	"created_by" varchar(255)
);
--> statement-breakpoint
ALTER TABLE "chat_channel_members" ADD COLUMN "added_by_role_id" varchar(30);--> statement-breakpoint
ALTER TABLE "chat_channel_role_links" ADD CONSTRAINT "chat_channel_role_links_channel_id_chat_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."chat_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_channel_role_links" ADD CONSTRAINT "chat_channel_role_links_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_channel_role_links_unique_idx" ON "chat_channel_role_links" USING btree ("channel_id","role_id");--> statement-breakpoint
CREATE INDEX "chat_channel_role_links_channel_idx" ON "chat_channel_role_links" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "chat_channel_role_links_role_idx" ON "chat_channel_role_links" USING btree ("role_id");--> statement-breakpoint
ALTER TABLE "chat_channel_members" ADD CONSTRAINT "chat_channel_members_added_by_role_id_roles_id_fk" FOREIGN KEY ("added_by_role_id") REFERENCES "public"."roles"("id") ON DELETE set null ON UPDATE no action;