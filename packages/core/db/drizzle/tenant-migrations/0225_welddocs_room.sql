ALTER TABLE "docs" ALTER COLUMN "content" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "docs" ADD COLUMN "revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "docs" ADD COLUMN "snapshot_key" varchar(1000);--> statement-breakpoint
ALTER TABLE "docs" ADD COLUMN "snapshot_revision" integer DEFAULT 0 NOT NULL;