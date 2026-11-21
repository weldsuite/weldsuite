ALTER TABLE "sheets" ALTER COLUMN "snapshot" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "sheets" ADD COLUMN "revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sheets" ADD COLUMN "snapshot_key" varchar(1000);--> statement-breakpoint
ALTER TABLE "sheets" ADD COLUMN "snapshot_revision" integer DEFAULT 0 NOT NULL;