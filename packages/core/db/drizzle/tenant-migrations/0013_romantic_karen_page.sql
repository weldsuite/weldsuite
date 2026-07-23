CREATE TABLE "warehouses" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"name" varchar(255) NOT NULL,
	"code" varchar(50),
	"description" text,
	"address_line_1" varchar(255),
	"address_line_2" varchar(255),
	"city" varchar(100),
	"state" varchar(100),
	"postal_code" varchar(20),
	"country" varchar(100),
	"contact_name" varchar(255),
	"contact_email" varchar(255),
	"contact_phone" varchar(50),
	"is_default" boolean DEFAULT false,
	"is_active" boolean DEFAULT true,
	"priority" integer DEFAULT 0,
	"total_locations" integer DEFAULT 0,
	"total_products" integer DEFAULT 0,
	"operating_hours" jsonb,
	"timezone" varchar(50),
	"metadata" jsonb,
	"tags" jsonb
);
--> statement-breakpoint
CREATE TABLE "warehouse_zones" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"warehouse_id" varchar(30) NOT NULL,
	"name" varchar(255) NOT NULL,
	"code" varchar(50),
	"description" text,
	"zone_type" varchar(50) DEFAULT 'storage',
	"is_active" boolean DEFAULT true,
	"priority" integer DEFAULT 0,
	"temperature_controlled" boolean DEFAULT false,
	"min_temperature" integer,
	"max_temperature" integer,
	"temperature_unit" varchar(5) DEFAULT 'C',
	"total_locations" integer DEFAULT 0,
	"picking_sequence" integer DEFAULT 0,
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "warehouse_locations" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"warehouse_id" varchar(30) NOT NULL,
	"zone_id" varchar(30),
	"name" varchar(255) NOT NULL,
	"code" varchar(50) NOT NULL,
	"barcode" varchar(100),
	"aisle" varchar(20),
	"rack" varchar(20),
	"shelf" varchar(20),
	"bin" varchar(20),
	"level" integer,
	"location_type" varchar(50) DEFAULT 'storage',
	"length" numeric(10, 2),
	"width" numeric(10, 2),
	"height" numeric(10, 2),
	"dimension_unit" varchar(10) DEFAULT 'cm',
	"max_weight" numeric(10, 2),
	"weight_unit" varchar(10) DEFAULT 'kg',
	"max_items" integer,
	"current_items" integer DEFAULT 0,
	"is_active" boolean DEFAULT true,
	"is_empty" boolean DEFAULT true,
	"is_blocked" boolean DEFAULT false,
	"block_reason" text,
	"picking_sequence" integer DEFAULT 0,
	"is_primary_pick" boolean DEFAULT false,
	"abc_class" varchar(1),
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "inventory" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"warehouse_id" varchar(30) NOT NULL,
	"location_id" varchar(30),
	"product_id" varchar(30) NOT NULL,
	"variant_id" varchar(30),
	"quantity_on_hand" integer DEFAULT 0 NOT NULL,
	"quantity_allocated" integer DEFAULT 0,
	"quantity_available" integer DEFAULT 0,
	"quantity_incoming" integer DEFAULT 0,
	"quantity_outgoing" integer DEFAULT 0,
	"lot_number" varchar(100),
	"batch_number" varchar(100),
	"serial_number" varchar(100),
	"expiry_date" timestamp,
	"manufacture_date" timestamp,
	"received_date" timestamp,
	"unit_cost" numeric(18, 2),
	"total_value" numeric(18, 2),
	"currency" varchar(3) DEFAULT 'USD',
	"status" varchar(30) DEFAULT 'available',
	"is_quarantined" boolean DEFAULT false,
	"quarantine_reason" text,
	"quality_status" varchar(30) DEFAULT 'passed',
	"last_inspection_date" timestamp,
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "stock_adjustments" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"product_id" varchar(30) NOT NULL,
	"variant_id" varchar(30),
	"warehouse_id" varchar(30),
	"location_id" varchar(30),
	"inventory_id" varchar(30),
	"type" varchar(30) NOT NULL,
	"previous_quantity" integer NOT NULL,
	"adjustment_quantity" integer NOT NULL,
	"new_quantity" integer NOT NULL,
	"lot_number" varchar(100),
	"batch_number" varchar(100),
	"reason" text,
	"reason_code" varchar(50),
	"notes" text,
	"performed_by" varchar(255),
	"performed_by_name" varchar(255),
	"source_type" varchar(30),
	"source_id" varchar(30),
	"source_number" varchar(100),
	"requires_approval" integer DEFAULT 0,
	"approval_status" varchar(30) DEFAULT 'approved',
	"approved_by" varchar(255),
	"approved_at" timestamp,
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "suppliers" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"name" varchar(255) NOT NULL,
	"code" varchar(50),
	"description" text,
	"contact_name" varchar(255),
	"email" varchar(255),
	"phone" varchar(50),
	"website" varchar(255),
	"address_line_1" varchar(255),
	"address_line_2" varchar(255),
	"city" varchar(100),
	"state" varchar(100),
	"postal_code" varchar(20),
	"country" varchar(100),
	"payment_terms" varchar(100),
	"currency" varchar(3) DEFAULT 'USD',
	"credit_limit" numeric(18, 2),
	"tax_id" varchar(50),
	"default_lead_time_days" integer,
	"minimum_order_value" numeric(18, 2),
	"is_active" boolean DEFAULT true,
	"status" varchar(30) DEFAULT 'active',
	"rating" integer,
	"notes" text,
	"metadata" jsonb,
	"tags" jsonb
);
--> statement-breakpoint
CREATE TABLE "purchase_orders" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"po_number" varchar(50) NOT NULL,
	"supplier_id" varchar(30),
	"supplier_name" varchar(255),
	"warehouse_id" varchar(30),
	"warehouse_name" varchar(255),
	"status" varchar(30) DEFAULT 'draft' NOT NULL,
	"order_date" timestamp,
	"expected_date" timestamp,
	"received_date" timestamp,
	"currency" varchar(3) DEFAULT 'USD',
	"subtotal" numeric(18, 2) DEFAULT '0',
	"tax_total" numeric(18, 2) DEFAULT '0',
	"shipping_total" numeric(18, 2) DEFAULT '0',
	"discount_total" numeric(18, 2) DEFAULT '0',
	"total" numeric(18, 2) DEFAULT '0',
	"item_count" integer DEFAULT 0,
	"total_quantity_ordered" integer DEFAULT 0,
	"total_quantity_received" integer DEFAULT 0,
	"shipping_method" varchar(100),
	"tracking_number" varchar(255),
	"payment_terms" varchar(100),
	"payment_status" varchar(30) DEFAULT 'pending',
	"supplier_notes" text,
	"internal_notes" text,
	"approved_by" varchar(255),
	"approved_at" timestamp,
	"created_by" varchar(255),
	"metadata" jsonb,
	"tags" jsonb
);
--> statement-breakpoint
CREATE TABLE "purchase_order_items" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"purchase_order_id" varchar(30) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"product_id" varchar(30),
	"variant_id" varchar(30),
	"sku" varchar(100),
	"name" varchar(255) NOT NULL,
	"description" text,
	"quantity_ordered" integer DEFAULT 1 NOT NULL,
	"quantity_received" integer DEFAULT 0,
	"quantity_pending" integer DEFAULT 0,
	"quantity_rejected" integer DEFAULT 0,
	"unit_price" numeric(18, 2) NOT NULL,
	"discount_percent" numeric(5, 2) DEFAULT '0',
	"discount_amount" numeric(18, 2) DEFAULT '0',
	"tax_percent" numeric(5, 2) DEFAULT '0',
	"tax_amount" numeric(18, 2) DEFAULT '0',
	"total" numeric(18, 2) NOT NULL,
	"last_received_date" timestamp,
	"destination_location_id" varchar(30),
	"expected_lot_number" varchar(100),
	"expected_expiry_date" timestamp,
	"notes" text,
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "pick_lists" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"pick_list_number" varchar(50) NOT NULL,
	"warehouse_id" varchar(30) NOT NULL,
	"status" varchar(30) DEFAULT 'pending' NOT NULL,
	"priority" varchar(20) DEFAULT 'normal',
	"assigned_to" varchar(255),
	"assigned_to_name" varchar(255),
	"assigned_at" timestamp,
	"total_items" integer DEFAULT 0,
	"picked_items" integer DEFAULT 0,
	"total_quantity" integer DEFAULT 0,
	"picked_quantity" integer DEFAULT 0,
	"started_at" timestamp,
	"completed_at" timestamp,
	"due_date" timestamp,
	"order_ids" jsonb,
	"order_count" integer DEFAULT 0,
	"pick_type" varchar(30) DEFAULT 'order',
	"notes" text,
	"created_by" varchar(255),
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "pick_list_items" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"pick_list_id" varchar(30) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"order_id" varchar(30),
	"order_item_id" varchar(30),
	"product_id" varchar(30) NOT NULL,
	"variant_id" varchar(30),
	"sku" varchar(100),
	"name" varchar(255) NOT NULL,
	"location_id" varchar(30),
	"location_code" varchar(50),
	"inventory_id" varchar(30),
	"quantity_required" integer DEFAULT 1 NOT NULL,
	"quantity_picked" integer DEFAULT 0,
	"quantity_short" integer DEFAULT 0,
	"lot_number" varchar(100),
	"batch_number" varchar(100),
	"expiry_date" timestamp,
	"status" varchar(30) DEFAULT 'pending',
	"pick_sequence" integer DEFAULT 0,
	"picked_at" timestamp,
	"picked_by" varchar(255),
	"is_substituted" integer DEFAULT 0,
	"original_product_id" varchar(30),
	"substitution_reason" text,
	"notes" text,
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "cycle_count_items" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"cycle_count_id" varchar(30) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"location_id" varchar(30) NOT NULL,
	"location_code" varchar(50),
	"product_id" varchar(30) NOT NULL,
	"variant_id" varchar(30),
	"sku" varchar(100),
	"name" varchar(255),
	"inventory_id" varchar(30),
	"lot_number" varchar(100),
	"batch_number" varchar(100),
	"expected_quantity" integer DEFAULT 0 NOT NULL,
	"counted_quantity" integer,
	"variance" integer,
	"status" varchar(30) DEFAULT 'pending',
	"counted_at" timestamp,
	"counted_by" varchar(255),
	"verified_quantity" integer,
	"verified_at" timestamp,
	"verified_by" varchar(255),
	"notes" text,
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "cycle_counts" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"count_number" varchar(50) NOT NULL,
	"warehouse_id" varchar(30) NOT NULL,
	"zone_id" varchar(30),
	"location_ids" jsonb,
	"count_type" varchar(30) DEFAULT 'full',
	"status" varchar(30) DEFAULT 'scheduled' NOT NULL,
	"scheduled_date" timestamp,
	"started_at" timestamp,
	"completed_at" timestamp,
	"assigned_to" varchar(255),
	"assigned_to_name" varchar(255),
	"total_locations" integer DEFAULT 0,
	"counted_locations" integer DEFAULT 0,
	"total_products" integer DEFAULT 0,
	"counted_products" integer DEFAULT 0,
	"variance_count" integer DEFAULT 0,
	"total_variance_quantity" integer DEFAULT 0,
	"requires_approval" integer DEFAULT 0,
	"approval_status" varchar(30) DEFAULT 'pending',
	"approved_by" varchar(255),
	"approved_at" timestamp,
	"notes" text,
	"created_by" varchar(255),
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "inventory_movements" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"movement_number" varchar(50) NOT NULL,
	"movement_type" varchar(30) NOT NULL,
	"status" varchar(30) DEFAULT 'pending' NOT NULL,
	"source_warehouse_id" varchar(30),
	"source_location_id" varchar(30),
	"source_location_code" varchar(50),
	"dest_warehouse_id" varchar(30),
	"dest_location_id" varchar(30),
	"dest_location_code" varchar(50),
	"product_id" varchar(30) NOT NULL,
	"variant_id" varchar(30),
	"sku" varchar(100),
	"name" varchar(255),
	"quantity" integer NOT NULL,
	"lot_number" varchar(100),
	"batch_number" varchar(100),
	"priority" varchar(20) DEFAULT 'normal',
	"assigned_to" varchar(255),
	"assigned_to_name" varchar(255),
	"started_at" timestamp,
	"completed_at" timestamp,
	"source_type" varchar(30),
	"source_id" varchar(30),
	"reason" text,
	"notes" text,
	"created_by" varchar(255),
	"completed_by" varchar(255),
	"metadata" jsonb
);
--> statement-breakpoint
CREATE INDEX "warehouses_workspace_idx" ON "warehouses" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "warehouses_code_idx" ON "warehouses" USING btree ("code");--> statement-breakpoint
CREATE INDEX "warehouses_is_active_idx" ON "warehouses" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "warehouse_zones_workspace_idx" ON "warehouse_zones" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "warehouse_zones_warehouse_idx" ON "warehouse_zones" USING btree ("warehouse_id");--> statement-breakpoint
CREATE INDEX "warehouse_zones_code_idx" ON "warehouse_zones" USING btree ("code");--> statement-breakpoint
CREATE INDEX "warehouse_zones_type_idx" ON "warehouse_zones" USING btree ("zone_type");--> statement-breakpoint
CREATE INDEX "warehouse_locations_workspace_idx" ON "warehouse_locations" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "warehouse_locations_warehouse_idx" ON "warehouse_locations" USING btree ("warehouse_id");--> statement-breakpoint
CREATE INDEX "warehouse_locations_zone_idx" ON "warehouse_locations" USING btree ("zone_id");--> statement-breakpoint
CREATE INDEX "warehouse_locations_code_idx" ON "warehouse_locations" USING btree ("code");--> statement-breakpoint
CREATE INDEX "warehouse_locations_barcode_idx" ON "warehouse_locations" USING btree ("barcode");--> statement-breakpoint
CREATE INDEX "warehouse_locations_type_idx" ON "warehouse_locations" USING btree ("location_type");--> statement-breakpoint
CREATE INDEX "inventory_workspace_idx" ON "inventory" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "inventory_warehouse_idx" ON "inventory" USING btree ("warehouse_id");--> statement-breakpoint
CREATE INDEX "inventory_location_idx" ON "inventory" USING btree ("location_id");--> statement-breakpoint
CREATE INDEX "inventory_product_idx" ON "inventory" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "inventory_lot_idx" ON "inventory" USING btree ("lot_number");--> statement-breakpoint
CREATE INDEX "inventory_expiry_idx" ON "inventory" USING btree ("expiry_date");--> statement-breakpoint
CREATE INDEX "inventory_status_idx" ON "inventory" USING btree ("status");--> statement-breakpoint
CREATE INDEX "stock_adjustments_workspace_idx" ON "stock_adjustments" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "stock_adjustments_product_idx" ON "stock_adjustments" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "stock_adjustments_warehouse_idx" ON "stock_adjustments" USING btree ("warehouse_id");--> statement-breakpoint
CREATE INDEX "stock_adjustments_location_idx" ON "stock_adjustments" USING btree ("location_id");--> statement-breakpoint
CREATE INDEX "stock_adjustments_type_idx" ON "stock_adjustments" USING btree ("type");--> statement-breakpoint
CREATE INDEX "stock_adjustments_source_idx" ON "stock_adjustments" USING btree ("source_type","source_id");--> statement-breakpoint
CREATE INDEX "stock_adjustments_created_idx" ON "stock_adjustments" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "suppliers_workspace_idx" ON "suppliers" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "suppliers_code_idx" ON "suppliers" USING btree ("code");--> statement-breakpoint
CREATE INDEX "suppliers_name_idx" ON "suppliers" USING btree ("name");--> statement-breakpoint
CREATE INDEX "suppliers_is_active_idx" ON "suppliers" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "purchase_orders_workspace_idx" ON "purchase_orders" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "purchase_orders_po_number_idx" ON "purchase_orders" USING btree ("po_number");--> statement-breakpoint
CREATE INDEX "purchase_orders_supplier_idx" ON "purchase_orders" USING btree ("supplier_id");--> statement-breakpoint
CREATE INDEX "purchase_orders_warehouse_idx" ON "purchase_orders" USING btree ("warehouse_id");--> statement-breakpoint
CREATE INDEX "purchase_orders_status_idx" ON "purchase_orders" USING btree ("status");--> statement-breakpoint
CREATE INDEX "purchase_orders_created_idx" ON "purchase_orders" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "po_items_workspace_idx" ON "purchase_order_items" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "po_items_po_idx" ON "purchase_order_items" USING btree ("purchase_order_id");--> statement-breakpoint
CREATE INDEX "po_items_product_idx" ON "purchase_order_items" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "pick_lists_workspace_idx" ON "pick_lists" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "pick_lists_number_idx" ON "pick_lists" USING btree ("pick_list_number");--> statement-breakpoint
CREATE INDEX "pick_lists_warehouse_idx" ON "pick_lists" USING btree ("warehouse_id");--> statement-breakpoint
CREATE INDEX "pick_lists_status_idx" ON "pick_lists" USING btree ("status");--> statement-breakpoint
CREATE INDEX "pick_lists_assigned_idx" ON "pick_lists" USING btree ("assigned_to");--> statement-breakpoint
CREATE INDEX "pick_lists_created_idx" ON "pick_lists" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "pick_list_items_workspace_idx" ON "pick_list_items" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "pick_list_items_list_idx" ON "pick_list_items" USING btree ("pick_list_id");--> statement-breakpoint
CREATE INDEX "pick_list_items_order_idx" ON "pick_list_items" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "pick_list_items_product_idx" ON "pick_list_items" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "pick_list_items_location_idx" ON "pick_list_items" USING btree ("location_id");--> statement-breakpoint
CREATE INDEX "pick_list_items_status_idx" ON "pick_list_items" USING btree ("status");--> statement-breakpoint
CREATE INDEX "cycle_count_items_workspace_idx" ON "cycle_count_items" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "cycle_count_items_count_idx" ON "cycle_count_items" USING btree ("cycle_count_id");--> statement-breakpoint
CREATE INDEX "cycle_count_items_location_idx" ON "cycle_count_items" USING btree ("location_id");--> statement-breakpoint
CREATE INDEX "cycle_count_items_product_idx" ON "cycle_count_items" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "cycle_count_items_status_idx" ON "cycle_count_items" USING btree ("status");--> statement-breakpoint
CREATE INDEX "cycle_counts_workspace_idx" ON "cycle_counts" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "cycle_counts_number_idx" ON "cycle_counts" USING btree ("count_number");--> statement-breakpoint
CREATE INDEX "cycle_counts_warehouse_idx" ON "cycle_counts" USING btree ("warehouse_id");--> statement-breakpoint
CREATE INDEX "cycle_counts_status_idx" ON "cycle_counts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "cycle_counts_scheduled_idx" ON "cycle_counts" USING btree ("scheduled_date");--> statement-breakpoint
CREATE INDEX "inventory_movements_workspace_idx" ON "inventory_movements" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "inventory_movements_number_idx" ON "inventory_movements" USING btree ("movement_number");--> statement-breakpoint
CREATE INDEX "inventory_movements_type_idx" ON "inventory_movements" USING btree ("movement_type");--> statement-breakpoint
CREATE INDEX "inventory_movements_status_idx" ON "inventory_movements" USING btree ("status");--> statement-breakpoint
CREATE INDEX "inventory_movements_source_loc_idx" ON "inventory_movements" USING btree ("source_location_id");--> statement-breakpoint
CREATE INDEX "inventory_movements_dest_loc_idx" ON "inventory_movements" USING btree ("dest_location_id");--> statement-breakpoint
CREATE INDEX "inventory_movements_product_idx" ON "inventory_movements" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "inventory_movements_created_idx" ON "inventory_movements" USING btree ("created_at");