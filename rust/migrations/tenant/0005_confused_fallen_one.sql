CREATE TABLE "woocommerce_connections" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"name" varchar(255) NOT NULL,
	"store_url" varchar(500) NOT NULL,
	"consumer_key" varchar(255) NOT NULL,
	"consumer_secret" text NOT NULL,
	"status" varchar(20) DEFAULT 'inactive' NOT NULL,
	"last_error" text,
	"last_error_at" timestamp,
	"sync_products" boolean DEFAULT true NOT NULL,
	"sync_products_outbound" boolean DEFAULT false NOT NULL,
	"sync_orders" boolean DEFAULT true NOT NULL,
	"sync_customers" boolean DEFAULT true NOT NULL,
	"auto_sync" boolean DEFAULT true NOT NULL,
	"sync_interval_minutes" integer DEFAULT 60 NOT NULL,
	"products_synced" integer DEFAULT 0 NOT NULL,
	"orders_synced" integer DEFAULT 0 NOT NULL,
	"customers_synced" integer DEFAULT 0 NOT NULL,
	"last_sync_at" timestamp,
	"webhook_id" varchar(100),
	"webhook_secret" varchar(255),
	"created_by" varchar(255)
);
--> statement-breakpoint
CREATE TABLE "woocommerce_customers" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"connection_id" varchar(30) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"woocommerce_id" integer NOT NULL,
	"email" varchar(255) NOT NULL,
	"first_name" varchar(100),
	"last_name" varchar(100),
	"username" varchar(100),
	"role" varchar(50),
	"orders_count" integer DEFAULT 0 NOT NULL,
	"total_spent" numeric(18, 2) DEFAULT '0' NOT NULL,
	"avatar_url" varchar(500),
	"billing_address" jsonb,
	"shipping_address" jsonb,
	"sync_status" varchar(30) DEFAULT 'synced' NOT NULL,
	"synced_at" timestamp,
	"master_customer_id" varchar(30),
	"raw_data" jsonb
);
--> statement-breakpoint
CREATE TABLE "woocommerce_orders" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"connection_id" varchar(30) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"woocommerce_id" integer NOT NULL,
	"order_number" varchar(50) NOT NULL,
	"status" varchar(30) NOT NULL,
	"total" numeric(18, 2),
	"subtotal" numeric(18, 2),
	"total_tax" numeric(18, 2),
	"shipping_total" numeric(18, 2),
	"discount_total" numeric(18, 2),
	"currency" varchar(3),
	"payment_method" varchar(100),
	"payment_method_title" varchar(255),
	"transaction_id" varchar(255),
	"customer_id" integer,
	"customer_name" varchar(255),
	"customer_email" varchar(255),
	"billing_address" jsonb,
	"shipping_address" jsonb,
	"line_items" jsonb,
	"order_date" timestamp,
	"date_completed" timestamp,
	"date_paid" timestamp,
	"customer_note" text,
	"sync_status" varchar(30) DEFAULT 'synced' NOT NULL,
	"synced_at" timestamp,
	"master_order_id" varchar(30),
	"raw_data" jsonb
);
--> statement-breakpoint
CREATE TABLE "woocommerce_products" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"connection_id" varchar(30) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"woocommerce_id" integer NOT NULL,
	"name" varchar(500) NOT NULL,
	"slug" varchar(500),
	"sku" varchar(100),
	"price" numeric(18, 2),
	"regular_price" numeric(18, 2),
	"sale_price" numeric(18, 2),
	"stock_status" varchar(30),
	"stock_quantity" integer,
	"manage_stock" varchar(10),
	"description" text,
	"short_description" text,
	"image_url" varchar(500),
	"images" jsonb,
	"permalink" varchar(500),
	"status" varchar(30),
	"type" varchar(30),
	"catalog_visibility" varchar(30),
	"categories" jsonb,
	"tags" jsonb,
	"attributes" jsonb,
	"variations" jsonb,
	"sync_status" varchar(30) DEFAULT 'synced' NOT NULL,
	"synced_at" timestamp,
	"master_product_id" varchar(30),
	"raw_data" jsonb
);
--> statement-breakpoint
CREATE TABLE "shopify_connections" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"name" varchar(255) NOT NULL,
	"shop_domain" varchar(255) NOT NULL,
	"access_token" text NOT NULL,
	"scope" varchar(500),
	"oauth_completed_at" timestamp,
	"status" varchar(20) DEFAULT 'oauth_pending' NOT NULL,
	"last_error" text,
	"last_error_at" timestamp,
	"sync_products" boolean DEFAULT true NOT NULL,
	"sync_collections" boolean DEFAULT true NOT NULL,
	"sync_orders" boolean DEFAULT true NOT NULL,
	"sync_customers" boolean DEFAULT true NOT NULL,
	"sync_fulfillment" boolean DEFAULT true NOT NULL,
	"sync_inventory" boolean DEFAULT true NOT NULL,
	"auto_sync" boolean DEFAULT true NOT NULL,
	"sync_interval_minutes" integer DEFAULT 60 NOT NULL,
	"products_synced" integer DEFAULT 0 NOT NULL,
	"variants_synced" integer DEFAULT 0 NOT NULL,
	"collections_synced" integer DEFAULT 0 NOT NULL,
	"orders_synced" integer DEFAULT 0 NOT NULL,
	"customers_synced" integer DEFAULT 0 NOT NULL,
	"last_sync_at" timestamp,
	"webhook_ids" jsonb,
	"created_by" varchar(255)
);
--> statement-breakpoint
CREATE TABLE "shopify_collections" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"connection_id" varchar(30) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"shopify_id" varchar(50) NOT NULL,
	"title" varchar(500) NOT NULL,
	"handle" varchar(500),
	"description" text,
	"description_html" text,
	"collection_type" varchar(30),
	"image" jsonb,
	"products_count" integer DEFAULT 0 NOT NULL,
	"sort_order" varchar(50),
	"published_at" timestamp,
	"shopify_updated_at" timestamp,
	"sync_status" varchar(30) DEFAULT 'synced' NOT NULL,
	"synced_at" timestamp,
	"raw_data" jsonb
);
--> statement-breakpoint
CREATE TABLE "shopify_customers" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"connection_id" varchar(30) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"shopify_id" varchar(50) NOT NULL,
	"email" varchar(255),
	"first_name" varchar(100),
	"last_name" varchar(100),
	"phone" varchar(50),
	"orders_count" integer DEFAULT 0 NOT NULL,
	"total_spent" numeric(18, 2) DEFAULT '0' NOT NULL,
	"currency" varchar(3),
	"state" varchar(30),
	"verified_email" boolean,
	"tax_exempt" boolean,
	"tags" jsonb,
	"email_marketing_consent" jsonb,
	"default_address" jsonb,
	"addresses" jsonb,
	"shopify_created_at" timestamp,
	"shopify_updated_at" timestamp,
	"sync_status" varchar(30) DEFAULT 'synced' NOT NULL,
	"synced_at" timestamp,
	"master_customer_id" varchar(30),
	"raw_data" jsonb
);
--> statement-breakpoint
CREATE TABLE "shopify_fulfillments" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"connection_id" varchar(30) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"shopify_id" varchar(50) NOT NULL,
	"order_shopify_id" varchar(50) NOT NULL,
	"order_id" varchar(30),
	"order_name" varchar(50),
	"status" varchar(30),
	"tracking_number" varchar(255),
	"tracking_numbers" jsonb,
	"tracking_company" varchar(255),
	"tracking_url" varchar(500),
	"tracking_urls" jsonb,
	"shipment_status" varchar(50),
	"line_items" jsonb,
	"items_count" integer DEFAULT 0 NOT NULL,
	"customer_name" varchar(255),
	"location_id" varchar(50),
	"shopify_created_at" timestamp,
	"shopify_updated_at" timestamp,
	"sync_status" varchar(30) DEFAULT 'synced' NOT NULL,
	"synced_at" timestamp,
	"raw_data" jsonb
);
--> statement-breakpoint
CREATE TABLE "shopify_orders" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"connection_id" varchar(30) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"shopify_id" varchar(50) NOT NULL,
	"order_number" integer NOT NULL,
	"name" varchar(50) NOT NULL,
	"email" varchar(255),
	"customer_id" varchar(50),
	"customer_name" varchar(255),
	"financial_status" varchar(30),
	"fulfillment_status" varchar(30),
	"total_price" numeric(18, 2),
	"subtotal_price" numeric(18, 2),
	"total_tax" numeric(18, 2),
	"total_shipping" numeric(18, 2),
	"total_discounts" numeric(18, 2),
	"currency" varchar(3),
	"items_count" integer DEFAULT 0 NOT NULL,
	"line_items" jsonb,
	"billing_address" jsonb,
	"shipping_address" jsonb,
	"payment_gateway_names" jsonb,
	"tags" jsonb,
	"note" text,
	"order_date" timestamp,
	"processed_at" timestamp,
	"closed_at" timestamp,
	"cancelled_at" timestamp,
	"sync_status" varchar(30) DEFAULT 'synced' NOT NULL,
	"synced_at" timestamp,
	"master_order_id" varchar(30),
	"raw_data" jsonb
);
--> statement-breakpoint
CREATE TABLE "shopify_products" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"connection_id" varchar(30) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"shopify_id" varchar(50) NOT NULL,
	"title" varchar(500) NOT NULL,
	"handle" varchar(500),
	"description" text,
	"description_html" text,
	"vendor" varchar(255),
	"product_type" varchar(255),
	"status" varchar(30),
	"tags" jsonb,
	"featured_image" jsonb,
	"images" jsonb,
	"options" jsonb,
	"variants_count" integer DEFAULT 0 NOT NULL,
	"images_count" integer DEFAULT 0 NOT NULL,
	"published_at" timestamp,
	"shopify_created_at" timestamp,
	"shopify_updated_at" timestamp,
	"seo_title" varchar(255),
	"seo_description" text,
	"sync_status" varchar(30) DEFAULT 'synced' NOT NULL,
	"synced_at" timestamp,
	"master_product_id" varchar(30),
	"raw_data" jsonb
);
--> statement-breakpoint
CREATE TABLE "shopify_variants" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"connection_id" varchar(30) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"shopify_id" varchar(50) NOT NULL,
	"product_shopify_id" varchar(50) NOT NULL,
	"product_id" varchar(30),
	"title" varchar(500) NOT NULL,
	"sku" varchar(100),
	"barcode" varchar(100),
	"price" numeric(18, 2),
	"compare_at_price" numeric(18, 2),
	"inventory_quantity" integer,
	"inventory_policy" varchar(30),
	"inventory_item_id" varchar(50),
	"weight" numeric(10, 2),
	"weight_unit" varchar(10),
	"option1" varchar(255),
	"option2" varchar(255),
	"option3" varchar(255),
	"image_id" varchar(50),
	"image_url" varchar(500),
	"position" integer,
	"taxable" boolean,
	"tax_code" varchar(50),
	"shopify_created_at" timestamp,
	"shopify_updated_at" timestamp,
	"sync_status" varchar(30) DEFAULT 'synced' NOT NULL,
	"synced_at" timestamp,
	"raw_data" jsonb
);
--> statement-breakpoint
CREATE TABLE "sync_logs" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"platform" varchar(30) NOT NULL,
	"connection_id" varchar(30) NOT NULL,
	"sync_type" varchar(30) NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"job_id" varchar(100),
	"triggered_by" varchar(20) NOT NULL,
	"triggered_by_user" varchar(255),
	"items_processed" integer DEFAULT 0 NOT NULL,
	"total_items" integer DEFAULT 0 NOT NULL,
	"items_created" integer DEFAULT 0 NOT NULL,
	"items_updated" integer DEFAULT 0 NOT NULL,
	"items_failed" integer DEFAULT 0 NOT NULL,
	"items_skipped" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp,
	"finished_at" timestamp,
	"duration_ms" integer,
	"error_message" text,
	"errors" jsonb,
	"metadata" jsonb
);
--> statement-breakpoint
ALTER TABLE "project_documents" ADD COLUMN "pages" jsonb;--> statement-breakpoint
ALTER TABLE "project_documents" ADD COLUMN "active_page_id" varchar(255);--> statement-breakpoint
CREATE INDEX "woocommerce_connections_workspace_idx" ON "woocommerce_connections" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "woocommerce_connections_status_idx" ON "woocommerce_connections" USING btree ("status");--> statement-breakpoint
CREATE INDEX "woocommerce_connections_store_url_idx" ON "woocommerce_connections" USING btree ("store_url");--> statement-breakpoint
CREATE INDEX "woocommerce_customers_workspace_idx" ON "woocommerce_customers" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "woocommerce_customers_connection_idx" ON "woocommerce_customers" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "woocommerce_customers_wc_id_idx" ON "woocommerce_customers" USING btree ("woocommerce_id");--> statement-breakpoint
CREATE INDEX "woocommerce_customers_email_idx" ON "woocommerce_customers" USING btree ("email");--> statement-breakpoint
CREATE INDEX "woocommerce_orders_workspace_idx" ON "woocommerce_orders" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "woocommerce_orders_connection_idx" ON "woocommerce_orders" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "woocommerce_orders_wc_id_idx" ON "woocommerce_orders" USING btree ("woocommerce_id");--> statement-breakpoint
CREATE INDEX "woocommerce_orders_order_number_idx" ON "woocommerce_orders" USING btree ("order_number");--> statement-breakpoint
CREATE INDEX "woocommerce_orders_status_idx" ON "woocommerce_orders" USING btree ("status");--> statement-breakpoint
CREATE INDEX "woocommerce_orders_customer_email_idx" ON "woocommerce_orders" USING btree ("customer_email");--> statement-breakpoint
CREATE INDEX "woocommerce_orders_order_date_idx" ON "woocommerce_orders" USING btree ("order_date");--> statement-breakpoint
CREATE INDEX "woocommerce_products_workspace_idx" ON "woocommerce_products" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "woocommerce_products_connection_idx" ON "woocommerce_products" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "woocommerce_products_wc_id_idx" ON "woocommerce_products" USING btree ("woocommerce_id");--> statement-breakpoint
CREATE INDEX "woocommerce_products_sku_idx" ON "woocommerce_products" USING btree ("sku");--> statement-breakpoint
CREATE INDEX "woocommerce_products_status_idx" ON "woocommerce_products" USING btree ("status");--> statement-breakpoint
CREATE INDEX "shopify_connections_workspace_idx" ON "shopify_connections" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "shopify_connections_status_idx" ON "shopify_connections" USING btree ("status");--> statement-breakpoint
CREATE INDEX "shopify_connections_shop_domain_idx" ON "shopify_connections" USING btree ("shop_domain");--> statement-breakpoint
CREATE INDEX "shopify_collections_workspace_idx" ON "shopify_collections" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "shopify_collections_connection_idx" ON "shopify_collections" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "shopify_collections_shopify_id_idx" ON "shopify_collections" USING btree ("shopify_id");--> statement-breakpoint
CREATE INDEX "shopify_collections_handle_idx" ON "shopify_collections" USING btree ("handle");--> statement-breakpoint
CREATE INDEX "shopify_customers_workspace_idx" ON "shopify_customers" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "shopify_customers_connection_idx" ON "shopify_customers" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "shopify_customers_shopify_id_idx" ON "shopify_customers" USING btree ("shopify_id");--> statement-breakpoint
CREATE INDEX "shopify_customers_email_idx" ON "shopify_customers" USING btree ("email");--> statement-breakpoint
CREATE INDEX "shopify_fulfillments_workspace_idx" ON "shopify_fulfillments" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "shopify_fulfillments_connection_idx" ON "shopify_fulfillments" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "shopify_fulfillments_shopify_id_idx" ON "shopify_fulfillments" USING btree ("shopify_id");--> statement-breakpoint
CREATE INDEX "shopify_fulfillments_order_shopify_id_idx" ON "shopify_fulfillments" USING btree ("order_shopify_id");--> statement-breakpoint
CREATE INDEX "shopify_fulfillments_status_idx" ON "shopify_fulfillments" USING btree ("status");--> statement-breakpoint
CREATE INDEX "shopify_fulfillments_tracking_number_idx" ON "shopify_fulfillments" USING btree ("tracking_number");--> statement-breakpoint
CREATE INDEX "shopify_orders_workspace_idx" ON "shopify_orders" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "shopify_orders_connection_idx" ON "shopify_orders" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "shopify_orders_shopify_id_idx" ON "shopify_orders" USING btree ("shopify_id");--> statement-breakpoint
CREATE INDEX "shopify_orders_order_number_idx" ON "shopify_orders" USING btree ("order_number");--> statement-breakpoint
CREATE INDEX "shopify_orders_financial_status_idx" ON "shopify_orders" USING btree ("financial_status");--> statement-breakpoint
CREATE INDEX "shopify_orders_fulfillment_status_idx" ON "shopify_orders" USING btree ("fulfillment_status");--> statement-breakpoint
CREATE INDEX "shopify_orders_email_idx" ON "shopify_orders" USING btree ("email");--> statement-breakpoint
CREATE INDEX "shopify_orders_order_date_idx" ON "shopify_orders" USING btree ("order_date");--> statement-breakpoint
CREATE INDEX "shopify_products_workspace_idx" ON "shopify_products" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "shopify_products_connection_idx" ON "shopify_products" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "shopify_products_shopify_id_idx" ON "shopify_products" USING btree ("shopify_id");--> statement-breakpoint
CREATE INDEX "shopify_products_handle_idx" ON "shopify_products" USING btree ("handle");--> statement-breakpoint
CREATE INDEX "shopify_products_status_idx" ON "shopify_products" USING btree ("status");--> statement-breakpoint
CREATE INDEX "shopify_variants_workspace_idx" ON "shopify_variants" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "shopify_variants_connection_idx" ON "shopify_variants" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "shopify_variants_shopify_id_idx" ON "shopify_variants" USING btree ("shopify_id");--> statement-breakpoint
CREATE INDEX "shopify_variants_product_shopify_id_idx" ON "shopify_variants" USING btree ("product_shopify_id");--> statement-breakpoint
CREATE INDEX "shopify_variants_sku_idx" ON "shopify_variants" USING btree ("sku");--> statement-breakpoint
CREATE INDEX "shopify_variants_barcode_idx" ON "shopify_variants" USING btree ("barcode");--> statement-breakpoint
CREATE INDEX "sync_logs_workspace_idx" ON "sync_logs" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "sync_logs_platform_idx" ON "sync_logs" USING btree ("platform");--> statement-breakpoint
CREATE INDEX "sync_logs_connection_idx" ON "sync_logs" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "sync_logs_status_idx" ON "sync_logs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "sync_logs_created_at_idx" ON "sync_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "sync_logs_job_id_idx" ON "sync_logs" USING btree ("job_id");