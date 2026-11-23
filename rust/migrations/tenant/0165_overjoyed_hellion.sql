CREATE TABLE "product_variants" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"product_id" varchar(30) NOT NULL,
	"name" varchar(255) NOT NULL,
	"sku" varchar(100),
	"barcode" varchar(100),
	"option_values" jsonb,
	"price" numeric(18, 2),
	"compare_at_price" numeric(18, 2),
	"cost_price" numeric(18, 2),
	"currency" varchar(3) DEFAULT 'USD',
	"track_inventory" boolean DEFAULT true,
	"inventory_quantity" integer DEFAULT 0,
	"low_stock_threshold" integer DEFAULT 5,
	"allow_backorder" boolean DEFAULT false,
	"weight" numeric(10, 3),
	"weight_unit" varchar(10) DEFAULT 'kg',
	"length" numeric(10, 2),
	"width" numeric(10, 2),
	"height" numeric(10, 2),
	"dimension_unit" varchar(10) DEFAULT 'cm',
	"requires_shipping" boolean DEFAULT true,
	"image_url" varchar(500),
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"position" integer DEFAULT 0,
	"attributes" jsonb,
	"custom_fields" jsonb,
	"created_by" varchar(255)
);
--> statement-breakpoint
CREATE TABLE "discounts" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"name" varchar(255) NOT NULL,
	"description" text,
	"code" varchar(100),
	"type" varchar(30) NOT NULL,
	"value" numeric(18, 2) DEFAULT '0' NOT NULL,
	"currency" varchar(3) DEFAULT 'USD',
	"max_discount_amount" numeric(18, 2),
	"applies_to" varchar(20) DEFAULT 'all' NOT NULL,
	"product_ids" jsonb,
	"variant_ids" jsonb,
	"category_ids" jsonb,
	"minimum_subtotal" numeric(18, 2),
	"minimum_quantity" integer,
	"usage_limit" integer,
	"usage_limit_per_customer" integer,
	"usage_count" integer DEFAULT 0,
	"once_per_customer" boolean DEFAULT false,
	"customer_eligibility" varchar(20) DEFAULT 'all',
	"customer_ids" jsonb,
	"combines_with_other_discounts" boolean DEFAULT false,
	"status" varchar(20) DEFAULT 'draft' NOT NULL,
	"starts_at" timestamp,
	"ends_at" timestamp,
	"custom_fields" jsonb,
	"created_by" varchar(255)
);
--> statement-breakpoint
CREATE INDEX "product_variants_product_idx" ON "product_variants" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "product_variants_sku_idx" ON "product_variants" USING btree ("sku");--> statement-breakpoint
CREATE INDEX "product_variants_barcode_idx" ON "product_variants" USING btree ("barcode");--> statement-breakpoint
CREATE INDEX "product_variants_status_idx" ON "product_variants" USING btree ("status");--> statement-breakpoint
CREATE INDEX "discounts_code_idx" ON "discounts" USING btree ("code");--> statement-breakpoint
CREATE INDEX "discounts_status_idx" ON "discounts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "discounts_type_idx" ON "discounts" USING btree ("type");--> statement-breakpoint
CREATE INDEX "discounts_ends_at_idx" ON "discounts" USING btree ("ends_at");