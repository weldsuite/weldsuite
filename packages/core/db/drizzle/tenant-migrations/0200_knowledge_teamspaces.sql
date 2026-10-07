CREATE TABLE "knowledge_space_members" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"space_id" varchar(255) NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"role" varchar(20) NOT NULL,
	"added_by" varchar(255),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"left_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "knowledge_spaces" ALTER COLUMN "visibility" SET DEFAULT 'open';--> statement-breakpoint
ALTER TABLE "knowledge_spaces" ADD COLUMN "kind" varchar(20) DEFAULT 'team' NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_spaces" ADD COLUMN "owner_id" varchar(255);--> statement-breakpoint
ALTER TABLE "knowledge_spaces" ADD COLUMN "is_default" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_space_members" ADD CONSTRAINT "knowledge_space_members_space_id_knowledge_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."knowledge_spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_space_members_space_user_idx" ON "knowledge_space_members" USING btree ("space_id","user_id");--> statement-breakpoint
CREATE INDEX "knowledge_space_members_user_idx" ON "knowledge_space_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_spaces_personal_owner_idx" ON "knowledge_spaces" USING btree ("owner_id") WHERE "knowledge_spaces"."kind" = 'personal' AND "knowledge_spaces"."deleted_at" IS NULL;--> statement-breakpoint
-- Backfill: today's 'workspace' spaces become open teamspaces; 'private' spaces
-- stay private teamspaces. Either way the creator becomes the owner, so a
-- space that was hidden stays hidden and keeps someone who can manage it.
UPDATE "knowledge_spaces" SET "visibility" = 'open' WHERE "visibility" = 'workspace';--> statement-breakpoint
INSERT INTO "knowledge_space_members" ("id", "space_id", "user_id", "role", "added_by", "created_at", "updated_at")
SELECT 'kspm_' || substr(md5("id" || clock_timestamp()::text), 1, 20), "id", "created_by", 'owner', "created_by", now(), now()
FROM "knowledge_spaces"
WHERE "created_by" IS NOT NULL
ON CONFLICT DO NOTHING;
