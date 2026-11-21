CREATE TABLE "product_suppliers" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"product_id" varchar(30) NOT NULL,
	"variant_id" varchar(30),
	"supplier_id" varchar(30) NOT NULL,
	"supplier_sku" varchar(100),
	"supplier_product_name" varchar(255),
	"unit_cost" numeric(18, 4),
	"currency" varchar(3),
	"lead_time_days" integer,
	"min_order_qty" integer,
	"order_multiple" integer DEFAULT 1 NOT NULL,
	"is_preferred" boolean DEFAULT false NOT NULL,
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "purchase_order_receipts" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"purchase_order_id" varchar(30) NOT NULL,
	"idempotency_key" varchar(100) NOT NULL,
	"lines" jsonb NOT NULL,
	"received_at" timestamp DEFAULT now() NOT NULL,
	"received_by" varchar(255),
	"received_by_name" varchar(255),
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "stash_item_plans" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"item_key" varchar(100) NOT NULL,
	"product_id" varchar(30) NOT NULL,
	"variant_id" varchar(30),
	"warehouse_id" varchar(30) NOT NULL,
	"run_id" varchar(30),
	"computed_at" timestamp,
	"method" varchar(20) DEFAULT 'none' NOT NULL,
	"confidence" varchar(10) DEFAULT 'none' NOT NULL,
	"history_days" integer DEFAULT 0 NOT NULL,
	"nonzero_days" integer DEFAULT 0 NOT NULL,
	"avg_daily_demand" numeric(14, 4),
	"demand_std_dev" numeric(14, 4),
	"seasonality" jsonb,
	"forecast_30d" numeric(14, 4),
	"forecast_90d" numeric(14, 4),
	"lead_time_days" integer,
	"review_period_days" integer,
	"service_level" numeric(4, 3),
	"product_supplier_id" varchar(30),
	"supplier_id" varchar(30),
	"safety_stock" integer,
	"reorder_point" integer,
	"order_up_to" integer,
	"on_hand" integer DEFAULT 0 NOT NULL,
	"allocated" integer DEFAULT 0 NOT NULL,
	"incoming" integer DEFAULT 0 NOT NULL,
	"open_demand" integer DEFAULT 0 NOT NULL,
	"inventory_position" integer DEFAULT 0 NOT NULL,
	"days_of_cover" numeric(10, 1),
	"stockout_date" date,
	"suggested_qty" integer DEFAULT 0 NOT NULL,
	"suggested_value" numeric(18, 2),
	"review_status" varchar(20) DEFAULT 'none' NOT NULL,
	"dismissed_until" timestamp,
	"dismissed_by" varchar(255),
	"dismissed_qty" integer,
	"purchase_order_id" varchar(30)
);
--> statement-breakpoint
CREATE TABLE "stash_planning_runs" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"trigger" varchar(20) NOT NULL,
	"status" varchar(20) DEFAULT 'running' NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"finished_at" timestamp,
	"items_planned" integer DEFAULT 0 NOT NULL,
	"items_to_reorder" integer DEFAULT 0 NOT NULL,
	"error" varchar(1000),
	"started_by" varchar(255)
);
--> statement-breakpoint
CREATE TABLE "stash_reorder_rules" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"item_key" varchar(100) NOT NULL,
	"product_id" varchar(30) NOT NULL,
	"variant_id" varchar(30),
	"warehouse_id" varchar(30) NOT NULL,
	"method" varchar(20) DEFAULT 'auto' NOT NULL,
	"min_qty" integer,
	"max_qty" integer,
	"service_level" numeric(4, 3),
	"review_period_days" integer,
	"lead_time_days_override" integer,
	"product_supplier_id" varchar(30)
);
--> statement-breakpoint
CREATE TABLE "stash_sales_history" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"date" date NOT NULL,
	"product_id" varchar(30) NOT NULL,
	"variant_id" varchar(30),
	"warehouse_id" varchar(30),
	"quantity" integer NOT NULL,
	"source" varchar(20) NOT NULL,
	"import_id" varchar(30),
	"connection_id" varchar(30),
	"external_ref" varchar(255)
);
--> statement-breakpoint
CREATE TABLE "stash_sales_history_imports" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"file_name" varchar(255) NOT NULL,
	"status" varchar(20) DEFAULT 'processing' NOT NULL,
	"rows_total" integer DEFAULT 0 NOT NULL,
	"rows_imported" integer DEFAULT 0 NOT NULL,
	"rows_skipped" integer DEFAULT 0 NOT NULL,
	"unmatched_skus" jsonb,
	"date_from" date,
	"date_to" date,
	"created_by" varchar(255)
);
--> statement-breakpoint
CREATE TABLE "stash_settings" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"replenishment_enabled" boolean DEFAULT false NOT NULL,
	"default_service_level" numeric(4, 3) DEFAULT '0.950' NOT NULL,
	"default_review_period_days" integer DEFAULT 7 NOT NULL,
	"lookback_days" integer DEFAULT 365 NOT NULL,
	"default_lead_time_days" integer DEFAULT 14 NOT NULL,
	"demand_warehouse_id" varchar(30),
	"history_cutover_date" date,
	"run_hour_utc" smallint DEFAULT 2 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "warehouses" ADD COLUMN "managed_by_connection_id" varchar(30);--> statement-breakpoint
CREATE INDEX "product_suppliers_product_idx" ON "product_suppliers" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "product_suppliers_supplier_idx" ON "product_suppliers" USING btree ("supplier_id");--> statement-breakpoint
CREATE UNIQUE INDEX "product_suppliers_unique" ON "product_suppliers" USING btree ("product_id",coalesce("variant_id", ''),"supplier_id") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "po_receipts_po_idx" ON "purchase_order_receipts" USING btree ("purchase_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "po_receipts_idempotency_unique" ON "purchase_order_receipts" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "stash_item_plans_item_unique" ON "stash_item_plans" USING btree ("item_key");--> statement-breakpoint
CREATE INDEX "stash_item_plans_review_idx" ON "stash_item_plans" USING btree ("review_status");--> statement-breakpoint
CREATE INDEX "stash_item_plans_supplier_idx" ON "stash_item_plans" USING btree ("supplier_id");--> statement-breakpoint
CREATE INDEX "stash_item_plans_warehouse_idx" ON "stash_item_plans" USING btree ("warehouse_id");--> statement-breakpoint
CREATE INDEX "stash_planning_runs_started_idx" ON "stash_planning_runs" USING btree ("started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "stash_reorder_rules_item_unique" ON "stash_reorder_rules" USING btree ("item_key");--> statement-breakpoint
CREATE INDEX "stash_reorder_rules_product_idx" ON "stash_reorder_rules" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "stash_sales_history_product_date_idx" ON "stash_sales_history" USING btree ("product_id","date");--> statement-breakpoint
CREATE INDEX "stash_sales_history_import_idx" ON "stash_sales_history" USING btree ("import_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stash_sales_history_external_unique" ON "stash_sales_history" USING btree ("connection_id","external_ref");--> statement-breakpoint
CREATE INDEX "stash_sales_history_imports_created_idx" ON "stash_sales_history_imports" USING btree ("created_at");