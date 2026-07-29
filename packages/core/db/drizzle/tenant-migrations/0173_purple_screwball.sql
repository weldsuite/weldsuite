ALTER TABLE "categories" ADD COLUMN "published_at" timestamp;--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN "type" varchar(20) DEFAULT 'manual';--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN "rules" jsonb;--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN "rules_match" varchar(3) DEFAULT 'all';--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN "sort_order" varchar(20) DEFAULT 'manual';--> statement-breakpoint
CREATE INDEX "categories_type_idx" ON "categories" USING btree ("type");--> statement-breakpoint
CREATE UNIQUE INDEX "category_products_unique" ON "category_products" USING btree ("category_id","product_id");