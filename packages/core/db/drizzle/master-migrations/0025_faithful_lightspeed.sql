DROP INDEX "database_pool_status_idx";--> statement-breakpoint
ALTER TABLE "database_pool" ADD COLUMN "region" varchar(50) DEFAULT 'aws-eu-central-1' NOT NULL;--> statement-breakpoint
CREATE INDEX "database_pool_status_idx" ON "database_pool" USING btree ("status","region");