CREATE TABLE "discount_redemptions" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"discount_id" varchar(30) NOT NULL,
	"order_id" varchar(30) NOT NULL,
	"person_id" varchar(30),
	"customer_email" varchar(255),
	"amount" numeric(18, 2) DEFAULT '0' NOT NULL,
	"currency" varchar(3),
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "commerce_settings" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"order_number_prefix" varchar(20) DEFAULT 'WC-' NOT NULL,
	"next_order_number" bigint DEFAULT 1001 NOT NULL,
	"default_currency" varchar(3) DEFAULT 'EUR' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "updated_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "vat_category" varchar(30);--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "tax_rate" numeric(7, 4);--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "external_line_id" varchar(100);--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "channel_id" varchar(30);--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "entity_id" varchar(30);--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "prices_include_tax" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "destination_country" varchar(2);--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "buyer_vat_number" varchar(50);--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "vat_treatment" varchar(30);--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "customer_reference" varchar(100);--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "approval_status" varchar(20) DEFAULT 'not_required' NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "placed_by_person_id" varchar(30);--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "idempotency_key" varchar(100);--> statement-breakpoint
-- Data fixes that the unique indexes below need (weldsuite-documentation/plans/weldcommerce-rebuild.md,
-- phase 2). Order numbers and discount codes were never unique and SKUs came in
-- through imports, so a workspace may hold duplicates. Each statement is
-- deterministic (oldest (created_at, id) keeps its value) and safe to run again.
-- 1. order_items.external_line_id from the provider line id the connector ingest
--    stored in properties.
UPDATE "order_items"
SET "external_line_id" = left("properties" ->> 'externalLineId', 100)
WHERE "external_line_id" IS NULL
  AND nullif("properties" ->> 'externalLineId', '') IS NOT NULL;--> statement-breakpoint
-- 2. Order numbers: within a source, later duplicates become '<number>-2', '-3', ...
--    (the first free suffix); the original is kept in metadata.originalOrderNumber.
DO $$
DECLARE
  r record;
  n integer;
  candidate text;
  suffix text;
BEGIN
  FOR r IN
    SELECT "id", "source", "order_number", "created_at" FROM (
      SELECT "id", "source", "order_number", "created_at",
        row_number() OVER (PARTITION BY "source", "order_number" ORDER BY "created_at", "id") AS rn
      FROM "orders"
      WHERE "deleted_at" IS NULL AND "source" IS NOT NULL
    ) d WHERE d.rn > 1
    ORDER BY d."created_at", d."id"
  LOOP
    n := 2;
    LOOP
      suffix := '-' || n;
      candidate := left(r."order_number", 50 - length(suffix)) || suffix;
      EXIT WHEN NOT EXISTS (
        SELECT 1 FROM "orders"
        WHERE "deleted_at" IS NULL AND "source" = r."source" AND "order_number" = candidate
      );
      n := n + 1;
    END LOOP;
    UPDATE "orders"
    SET "order_number" = candidate,
        "metadata" = coalesce("metadata", '{}'::jsonb) || jsonb_build_object('originalOrderNumber', r."order_number"),
        "updated_at" = now()
    WHERE "id" = r."id";
  END LOOP;
END $$;--> statement-breakpoint
-- 3. Discount codes: the most recently updated non-archived row keeps the code,
--    the others are archived (the code stays on the row for the history).
UPDATE "discounts" d
SET "status" = 'archived',
    "custom_fields" = coalesce(d."custom_fields", '{}'::jsonb) || jsonb_build_object('archivedReason', 'duplicate_code'),
    "updated_at" = now()
FROM (
  SELECT "id", row_number() OVER (
    PARTITION BY lower(trim("code"))
    ORDER BY "updated_at" DESC, "created_at" DESC, "id" DESC
  ) AS rn
  FROM "discounts"
  WHERE "code" IS NOT NULL AND "deleted_at" IS NULL AND "status" <> 'archived'
) k
WHERE d."id" = k."id" AND k.rn > 1;--> statement-breakpoint
-- 4. SKUs and barcodes among live rows of products and of product_variants: later
--    duplicates get '-DUP2', '-DUP3', ...; the original is kept in custom_fields.
DO $$
DECLARE
  r record;
  n integer;
  candidate text;
  suffix text;
BEGIN
  FOR r IN
    SELECT "id", "sku" AS val FROM (
      SELECT "id", "sku", "created_at",
        row_number() OVER (PARTITION BY "sku" ORDER BY "created_at", "id") AS rn
      FROM "products" WHERE "deleted_at" IS NULL AND "sku" IS NOT NULL AND "sku" <> ''
    ) d WHERE d.rn > 1 ORDER BY d."created_at", d."id"
  LOOP
    n := 2;
    LOOP
      suffix := '-DUP' || n;
      candidate := left(r.val, 100 - length(suffix)) || suffix;
      EXIT WHEN NOT EXISTS (SELECT 1 FROM "products" WHERE "deleted_at" IS NULL AND "sku" = candidate);
      n := n + 1;
    END LOOP;
    UPDATE "products" SET "sku" = candidate,
      "custom_fields" = coalesce("custom_fields", '{}'::jsonb) || jsonb_build_object('originalSku', r.val),
      "updated_at" = now()
    WHERE "id" = r."id";
  END LOOP;

  FOR r IN
    SELECT "id", "barcode" AS val FROM (
      SELECT "id", "barcode", "created_at",
        row_number() OVER (PARTITION BY "barcode" ORDER BY "created_at", "id") AS rn
      FROM "products" WHERE "deleted_at" IS NULL AND "barcode" IS NOT NULL AND "barcode" <> ''
    ) d WHERE d.rn > 1 ORDER BY d."created_at", d."id"
  LOOP
    n := 2;
    LOOP
      suffix := '-DUP' || n;
      candidate := left(r.val, 100 - length(suffix)) || suffix;
      EXIT WHEN NOT EXISTS (SELECT 1 FROM "products" WHERE "deleted_at" IS NULL AND "barcode" = candidate);
      n := n + 1;
    END LOOP;
    UPDATE "products" SET "barcode" = candidate,
      "custom_fields" = coalesce("custom_fields", '{}'::jsonb) || jsonb_build_object('originalBarcode', r.val),
      "updated_at" = now()
    WHERE "id" = r."id";
  END LOOP;

  FOR r IN
    SELECT "id", "sku" AS val FROM (
      SELECT "id", "sku", "created_at",
        row_number() OVER (PARTITION BY "sku" ORDER BY "created_at", "id") AS rn
      FROM "product_variants" WHERE "deleted_at" IS NULL AND "sku" IS NOT NULL AND "sku" <> ''
    ) d WHERE d.rn > 1 ORDER BY d."created_at", d."id"
  LOOP
    n := 2;
    LOOP
      suffix := '-DUP' || n;
      candidate := left(r.val, 100 - length(suffix)) || suffix;
      EXIT WHEN NOT EXISTS (SELECT 1 FROM "product_variants" WHERE "deleted_at" IS NULL AND "sku" = candidate);
      n := n + 1;
    END LOOP;
    UPDATE "product_variants" SET "sku" = candidate,
      "custom_fields" = coalesce("custom_fields", '{}'::jsonb) || jsonb_build_object('originalSku', r.val),
      "updated_at" = now()
    WHERE "id" = r."id";
  END LOOP;

  FOR r IN
    SELECT "id", "barcode" AS val FROM (
      SELECT "id", "barcode", "created_at",
        row_number() OVER (PARTITION BY "barcode" ORDER BY "created_at", "id") AS rn
      FROM "product_variants" WHERE "deleted_at" IS NULL AND "barcode" IS NOT NULL AND "barcode" <> ''
    ) d WHERE d.rn > 1 ORDER BY d."created_at", d."id"
  LOOP
    n := 2;
    LOOP
      suffix := '-DUP' || n;
      candidate := left(r.val, 100 - length(suffix)) || suffix;
      EXIT WHEN NOT EXISTS (SELECT 1 FROM "product_variants" WHERE "deleted_at" IS NULL AND "barcode" = candidate);
      n := n + 1;
    END LOOP;
    UPDATE "product_variants" SET "barcode" = candidate,
      "custom_fields" = coalesce("custom_fields", '{}'::jsonb) || jsonb_build_object('originalBarcode', r.val),
      "updated_at" = now()
    WHERE "id" = r."id";
  END LOOP;
END $$;--> statement-breakpoint
CREATE INDEX "discount_redemptions_discount_idx" ON "discount_redemptions" USING btree ("discount_id");--> statement-breakpoint
CREATE INDEX "discount_redemptions_order_idx" ON "discount_redemptions" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "discount_redemptions_person_idx" ON "discount_redemptions" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "discount_redemptions_email_idx" ON "discount_redemptions" USING btree (lower("customer_email"::text));--> statement-breakpoint
CREATE UNIQUE INDEX "discount_redemptions_discount_order_uidx" ON "discount_redemptions" USING btree ("discount_id","order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "products_sku_uidx" ON "products" USING btree ("sku") WHERE "products"."sku" IS NOT NULL AND "products"."sku" <> '' AND "products"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "products_barcode_uidx" ON "products" USING btree ("barcode") WHERE "products"."barcode" IS NOT NULL AND "products"."barcode" <> '' AND "products"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "product_variants_sku_uidx" ON "product_variants" USING btree ("sku") WHERE "product_variants"."sku" IS NOT NULL AND "product_variants"."sku" <> '' AND "product_variants"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "product_variants_barcode_uidx" ON "product_variants" USING btree ("barcode") WHERE "product_variants"."barcode" IS NOT NULL AND "product_variants"."barcode" <> '' AND "product_variants"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "order_items_order_external_line_idx" ON "order_items" USING btree ("order_id","external_line_id");--> statement-breakpoint
CREATE INDEX "orders_channel_idx" ON "orders" USING btree ("channel_id");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_idempotency_key_uidx" ON "orders" USING btree ("idempotency_key") WHERE "orders"."idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "orders_source_order_number_uidx" ON "orders" USING btree ("source","order_number") WHERE "orders"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "discounts_code_uidx" ON "discounts" USING btree (lower(trim("code"))) WHERE "discounts"."code" IS NOT NULL AND "discounts"."deleted_at" IS NULL AND "discounts"."status" <> 'archived';