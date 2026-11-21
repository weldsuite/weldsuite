ALTER TABLE "products" ADD COLUMN "track_lots" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "track_serials" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "track_expiry" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN "published_at" timestamp;--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN "type" varchar(20) DEFAULT 'manual';--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN "rules" jsonb;--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN "rules_match" varchar(3) DEFAULT 'all';--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN "sort_order" varchar(20) DEFAULT 'manual';--> statement-breakpoint
CREATE INDEX "categories_type_idx" ON "categories" USING btree ("type");--> statement-breakpoint
/* Hand-added backfill. `category_products` has never carried a uniqueness
   constraint, so a tenant may already hold duplicate (category_id, product_id)
   pairs — on those the CREATE UNIQUE INDEX below aborts the whole migration.
   Collapse each pair to its earliest row, which keeps the original curated
   `position`; ctid breaks ties on identical timestamps. */
DELETE FROM "category_products" a
  USING "category_products" b
  WHERE a."category_id" = b."category_id"
    AND a."product_id" = b."product_id"
    AND (a."created_at", a.ctid) > (b."created_at", b.ctid);--> statement-breakpoint
CREATE UNIQUE INDEX "category_products_unique" ON "category_products" USING btree ("category_id","product_id");--> statement-breakpoint
/* Hand-added backfill. Same problem, harder fix: stock written before the
   ledger existed could have left two `inventory` rows for one natural key, and
   both hold real units. Dropping one would destroy stock, so duplicates are
   merged into the earliest row and the rest soft-deleted.

   PARTITION BY treats NULLs as equal, matching the NULLS NOT DISTINCT index
   below. Data-modifying CTEs all run against the same snapshot and each runs to
   completion whether or not the outer query reads it, so `merged` lands even
   though only `losers` is referenced at the end. */
WITH ranked AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "product_id", "warehouse_id", "variant_id", "location_id", "lot_number"
      ORDER BY "created_at", "id"
    ) AS rn,
    FIRST_VALUE("id") OVER (
      PARTITION BY "product_id", "warehouse_id", "variant_id", "location_id", "lot_number"
      ORDER BY "created_at", "id"
    ) AS survivor_id
  FROM "inventory"
  WHERE "deleted_at" IS NULL
),
losers AS (
  SELECT "id", survivor_id FROM ranked WHERE rn > 1
),
totals AS (
  SELECT
    l.survivor_id,
    SUM(i."quantity_on_hand") AS qoh,
    SUM(COALESCE(i."quantity_allocated", 0)) AS allocated,
    SUM(COALESCE(i."quantity_incoming", 0)) AS incoming,
    SUM(COALESCE(i."quantity_outgoing", 0)) AS outgoing
  FROM losers l
  JOIN "inventory" i ON i."id" = l."id"
  GROUP BY l.survivor_id
),
merged AS (
  UPDATE "inventory" s SET
    "quantity_on_hand" = s."quantity_on_hand" + t.qoh,
    "quantity_allocated" = COALESCE(s."quantity_allocated", 0) + t.allocated,
    "quantity_incoming" = COALESCE(s."quantity_incoming", 0) + t.incoming,
    "quantity_outgoing" = COALESCE(s."quantity_outgoing", 0) + t.outgoing,
    "quantity_available" = (s."quantity_on_hand" + t.qoh)
      - (COALESCE(s."quantity_allocated", 0) + t.allocated),
    "updated_at" = now()
  FROM totals t
  WHERE s."id" = t.survivor_id
  RETURNING s."id"
)
UPDATE "inventory" SET "deleted_at" = now(), "updated_at" = now()
  WHERE "id" IN (SELECT "id" FROM losers);--> statement-breakpoint
/* `NULLS NOT DISTINCT` is hand-added: drizzle-orm 0.45's index builder cannot
   express it, so the generated statement omits it. Without the modifier a
   bucket with no variant / location / lot never collides with another — which
   is the overwhelmingly common shape, and exactly what needs protecting. The
   schema declaration in src/schema/inventory.ts carries a matching note. */
CREATE UNIQUE INDEX "inventory_bucket_unique" ON "inventory" USING btree ("product_id","warehouse_id","variant_id","location_id","lot_number") NULLS NOT DISTINCT WHERE deleted_at IS NULL;
