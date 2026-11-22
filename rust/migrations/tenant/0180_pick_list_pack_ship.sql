ALTER TABLE "pick_lists" ADD COLUMN IF NOT EXISTS "packed_at" timestamp;--> statement-breakpoint
ALTER TABLE "pick_lists" ADD COLUMN IF NOT EXISTS "packed_by" varchar(255);--> statement-breakpoint
ALTER TABLE "pick_lists" ADD COLUMN IF NOT EXISTS "shipped_at" timestamp;--> statement-breakpoint
ALTER TABLE "pick_lists" ADD COLUMN IF NOT EXISTS "shipment_id" varchar(30);--> statement-breakpoint
ALTER TABLE "pick_lists" ADD COLUMN IF NOT EXISTS "parcel_id" varchar(30);
