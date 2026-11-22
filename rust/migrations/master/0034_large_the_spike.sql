ALTER TABLE "database_pool" ADD COLUMN "kind" varchar(20) DEFAULT 'dedicated' NOT NULL;--> statement-breakpoint
ALTER TABLE "database_pool" ADD COLUMN "shared_project_id" varchar(30);--> statement-breakpoint
CREATE INDEX "database_pool_kind_status_idx" ON "database_pool" USING btree ("kind","status","region");