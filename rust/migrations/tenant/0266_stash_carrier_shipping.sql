ALTER TABLE "parcels" ADD COLUMN "pick_list_id" varchar(30);--> statement-breakpoint
ALTER TABLE "parcels" ADD COLUMN "carrier_code" varchar(30);--> statement-breakpoint
ALTER TABLE "parcels" ADD COLUMN "carrier_reference" varchar(100);--> statement-breakpoint
ALTER TABLE "parcels" ADD COLUMN "tracking_url" varchar(500);--> statement-breakpoint
ALTER TABLE "parcels" ADD COLUMN "collo_number" integer;--> statement-breakpoint
ALTER TABLE "parcels" ADD COLUMN "service_point" jsonb;--> statement-breakpoint
ALTER TABLE "parcels" ADD COLUMN "return_for_parcel_id" varchar(30);--> statement-breakpoint
ALTER TABLE "parcels" ADD COLUMN "tracking_next_check_at" timestamp;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "hs_code" varchar(20);--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "origin_country" varchar(2);--> statement-breakpoint
CREATE INDEX "parcels_pick_list_id_idx" ON "parcels" USING btree ("pick_list_id");--> statement-breakpoint
CREATE INDEX "parcels_return_for_parcel_id_idx" ON "parcels" USING btree ("return_for_parcel_id");--> statement-breakpoint
CREATE INDEX "parcels_tracking_next_check_at_idx" ON "parcels" USING btree ("tracking_next_check_at") WHERE "parcels"."tracking_next_check_at" IS NOT NULL;