DROP INDEX "orders_source_order_number_uidx";--> statement-breakpoint
CREATE UNIQUE INDEX "orders_native_order_number_uidx" ON "orders" USING btree ("source","order_number") WHERE "orders"."deleted_at" IS NULL AND "orders"."source" IN ('manual', 'storefront');--> statement-breakpoint
-- Imported orders keep their store's own number (two stores of the same
-- provider may both have a #1001): put back the numbers migration 0257
-- suffixed to satisfy the wider index this migration replaces.
UPDATE "orders"
SET "order_number" = "metadata" ->> 'originalOrderNumber',
    "metadata" = "metadata" - 'originalOrderNumber',
    "updated_at" = now()
WHERE ("source" IS NULL OR "source" NOT IN ('manual', 'storefront'))
  AND ("metadata" ->> 'originalOrderNumber') IS NOT NULL
  AND "order_number" LIKE ("metadata" ->> 'originalOrderNumber') || '-%';
