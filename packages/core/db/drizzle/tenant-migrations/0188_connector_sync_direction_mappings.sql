ALTER TABLE "connector_connections" ADD COLUMN IF NOT EXISTS "direction" varchar(15) DEFAULT 'inbound' NOT NULL;--> statement-breakpoint
ALTER TABLE "connector_connections" ADD COLUMN IF NOT EXISTS "object_sync_directions" jsonb;
