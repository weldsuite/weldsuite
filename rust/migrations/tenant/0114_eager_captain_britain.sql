CREATE TABLE "member_notes" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"author_user_id" varchar(255) NOT NULL,
	"subject_user_id" varchar(255) NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspace_members" ADD COLUMN "title" varchar(120);--> statement-breakpoint
ALTER TABLE "workspace_members" ADD COLUMN "bio" text;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD COLUMN "phone" varchar(40);--> statement-breakpoint
ALTER TABLE "workspace_members" ADD COLUMN "location" varchar(120);--> statement-breakpoint
ALTER TABLE "workspace_members" ADD COLUMN "pronouns" varchar(40);--> statement-breakpoint
ALTER TABLE "workspace_members" ADD COLUMN "links" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "member_notes_author_subject_unique" ON "member_notes" USING btree ("author_user_id","subject_user_id");--> statement-breakpoint
CREATE INDEX "member_notes_subject_idx" ON "member_notes" USING btree ("subject_user_id");