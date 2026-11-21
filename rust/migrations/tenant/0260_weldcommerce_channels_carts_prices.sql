CREATE TABLE "commerce_channel_keys" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"channel_id" varchar(30) NOT NULL,
	"kind" varchar(12) NOT NULL,
	"name" varchar(255),
	"key_hash" varchar(64) NOT NULL,
	"key_prefix" varchar(16) NOT NULL,
	"allowed_origins" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rotated_from_id" varchar(30),
	"created_by" varchar(255),
	"last_used_at" timestamp,
	"revoked_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "commerce_channels" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"name" varchar(255) NOT NULL,
	"type" varchar(30) DEFAULT 'storefront' NOT NULL,
	"audience" varchar(10) DEFAULT 'b2c' NOT NULL,
	"status" varchar(20) DEFAULT 'draft' NOT NULL,
	"currency" varchar(3) DEFAULT 'EUR' NOT NULL,
	"prices_include_tax" boolean DEFAULT true NOT NULL,
	"selling_countries" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"guest_checkout" boolean DEFAULT true NOT NULL,
	"payment_methods" jsonb DEFAULT '["mollie"]'::jsonb NOT NULL,
	"connection_id" varchar(30)
);
--> statement-breakpoint
CREATE TABLE "commerce_shipping_rates" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"channel_id" varchar(30) NOT NULL,
	"zone_name" varchar(255) NOT NULL,
	"countries" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"name" varchar(255) NOT NULL,
	"price" numeric(18, 2) DEFAULT '0' NOT NULL,
	"currency" varchar(3) DEFAULT 'EUR' NOT NULL,
	"free_shipping_threshold" numeric(18, 2),
	"position" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_prices" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"product_id" varchar(30) NOT NULL,
	"variant_id" varchar(30),
	"currency" varchar(3) NOT NULL,
	"price" numeric(18, 2) NOT NULL,
	"compare_at_price" numeric(18, 2)
);
--> statement-breakpoint
CREATE TABLE "cart_items" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"cart_id" varchar(30) NOT NULL,
	"product_id" varchar(30) NOT NULL,
	"variant_id" varchar(30),
	"sku" varchar(100),
	"name" varchar(255),
	"quantity" integer DEFAULT 1 NOT NULL,
	"unit_price" numeric(18, 2),
	"properties" jsonb
);
--> statement-breakpoint
CREATE TABLE "carts" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"channel_id" varchar(30) NOT NULL,
	"status" varchar(20) DEFAULT 'open' NOT NULL,
	"currency" varchar(3) NOT NULL,
	"prices_include_tax" boolean DEFAULT true NOT NULL,
	"person_id" varchar(30),
	"company_id" varchar(30),
	"buyer_id" varchar(30),
	"email" varchar(255),
	"billing_address" jsonb,
	"shipping_address" jsonb,
	"destination_country" varchar(2),
	"shipping_rate_id" varchar(30),
	"discount_id" varchar(30),
	"discount_code" varchar(100),
	"buyer_vat_number" varchar(50),
	"vat_treatment" varchar(30),
	"vat_quote" jsonb,
	"customer_reference" varchar(100),
	"note" varchar(1000),
	"subtotal" numeric(18, 2) DEFAULT '0' NOT NULL,
	"discount_total" numeric(18, 2) DEFAULT '0' NOT NULL,
	"shipping_total" numeric(18, 2) DEFAULT '0' NOT NULL,
	"tax_total" numeric(18, 2) DEFAULT '0' NOT NULL,
	"total" numeric(18, 2) DEFAULT '0' NOT NULL,
	"expires_at" timestamp,
	"order_id" varchar(30),
	"completed_at" timestamp,
	"idempotency_key" varchar(100)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_channel_keys_hash_uidx" ON "commerce_channel_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "commerce_channel_keys_channel_idx" ON "commerce_channel_keys" USING btree ("channel_id","kind");--> statement-breakpoint
CREATE INDEX "commerce_channels_type_idx" ON "commerce_channels" USING btree ("type");--> statement-breakpoint
CREATE INDEX "commerce_channels_status_idx" ON "commerce_channels" USING btree ("status");--> statement-breakpoint
CREATE INDEX "commerce_channels_connection_idx" ON "commerce_channels" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "commerce_channels_created_idx" ON "commerce_channels" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "commerce_shipping_rates_channel_idx" ON "commerce_shipping_rates" USING btree ("channel_id","position");--> statement-breakpoint
CREATE INDEX "product_prices_product_idx" ON "product_prices" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "product_prices_variant_idx" ON "product_prices" USING btree ("variant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "product_prices_product_currency_uidx" ON "product_prices" USING btree ("product_id","currency") WHERE "product_prices"."variant_id" IS NULL AND "product_prices"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "product_prices_variant_currency_uidx" ON "product_prices" USING btree ("product_id","variant_id","currency") WHERE "product_prices"."variant_id" IS NOT NULL AND "product_prices"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "cart_items_cart_idx" ON "cart_items" USING btree ("cart_id");--> statement-breakpoint
CREATE INDEX "cart_items_product_idx" ON "cart_items" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cart_items_cart_product_uidx" ON "cart_items" USING btree ("cart_id","product_id") WHERE "cart_items"."variant_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "cart_items_cart_variant_uidx" ON "cart_items" USING btree ("cart_id","product_id","variant_id") WHERE "cart_items"."variant_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "carts_token_hash_uidx" ON "carts" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "carts_channel_status_idx" ON "carts" USING btree ("channel_id","status");--> statement-breakpoint
CREATE INDEX "carts_person_idx" ON "carts" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "carts_company_idx" ON "carts" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "carts_order_idx" ON "carts" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "carts_expires_at_idx" ON "carts" USING btree ("expires_at") WHERE "carts"."status" IN ('open', 'checkout');--> statement-breakpoint
CREATE UNIQUE INDEX "carts_idempotency_key_uidx" ON "carts" USING btree ("channel_id","idempotency_key") WHERE "carts"."idempotency_key" IS NOT NULL;