CREATE TABLE "helpdesk_analytics_reports" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"title" varchar(255) NOT NULL,
	"description" text,
	"created_by_id" varchar(255),
	"chart_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "helpdesk_analytics_charts" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"report_id" varchar(30) NOT NULL,
	"title" varchar(255) NOT NULL,
	"description" text,
	"chart_type" varchar(50) NOT NULL,
	"entity" varchar(50) NOT NULL,
	"metric" varchar(100) NOT NULL,
	"color" varchar(20) DEFAULT '#3b82f6' NOT NULL,
	"smooth_curve" boolean DEFAULT true NOT NULL,
	"fill_area" boolean DEFAULT true NOT NULL,
	"show_data_labels" boolean DEFAULT false NOT NULL,
	"show_legend" boolean DEFAULT true NOT NULL,
	"time_range" varchar(50) DEFAULT 'last_30_days',
	"group_by" varchar(50) DEFAULT 'day',
	"aggregation" varchar(50) DEFAULT 'sum',
	"sort_order" varchar(10) DEFAULT 'asc',
	"limit" integer,
	"compare_with" varchar(50),
	"layout" jsonb NOT NULL,
	"sort_index" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "carriers" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"name" varchar(255) NOT NULL,
	"code" varchar(50) NOT NULL,
	"logo" varchar(500),
	"website" varchar(500),
	"is_active" boolean DEFAULT true,
	"is_default" boolean DEFAULT false,
	"integration_type" varchar(20) DEFAULT 'manual' NOT NULL,
	"api_credentials" jsonb,
	"supported_services" jsonb,
	"supported_countries" jsonb,
	"features" jsonb,
	"tracking_url_template" varchar(500),
	"support_email" varchar(255),
	"support_phone" varchar(50),
	"account_number" varchar(100),
	"settings" jsonb,
	"description" text
);
--> statement-breakpoint
CREATE TABLE "carrier_services" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"carrier_id" varchar(30) NOT NULL,
	"name" varchar(255) NOT NULL,
	"code" varchar(50) NOT NULL,
	"external_id" varchar(100),
	"description" text,
	"delivery_days" integer,
	"cutoff_time" varchar(10),
	"is_express" boolean DEFAULT false,
	"has_tracking" boolean DEFAULT true,
	"has_insurance" boolean DEFAULT false,
	"max_insurance_value" numeric(18, 2),
	"base_price" numeric(18, 2),
	"currency" varchar(3) DEFAULT 'EUR',
	"supported_countries" jsonb,
	"configuration" jsonb,
	"is_active" boolean DEFAULT true
);
--> statement-breakpoint
CREATE TABLE "boxes" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"name" varchar(255) NOT NULL,
	"code" varchar(50) NOT NULL,
	"length" numeric(10, 2) NOT NULL,
	"width" numeric(10, 2) NOT NULL,
	"height" numeric(10, 2) NOT NULL,
	"dimension_unit" varchar(5) DEFAULT 'cm' NOT NULL,
	"tare_weight" numeric(10, 3),
	"max_weight" numeric(10, 3),
	"weight_unit" varchar(5) DEFAULT 'kg' NOT NULL,
	"type" varchar(20) DEFAULT 'box' NOT NULL,
	"material" varchar(100),
	"is_default" boolean DEFAULT false,
	"is_active" boolean DEFAULT true,
	"cost" jsonb,
	"image" varchar(500),
	"description" text
);
--> statement-breakpoint
CREATE TABLE "parcels" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"tracking_number" varchar(100),
	"reference_number" varchar(100),
	"barcode" varchar(100),
	"status" varchar(30) DEFAULT 'draft' NOT NULL,
	"status_history" jsonb,
	"shipment_id" varchar(30),
	"order_id" varchar(30),
	"order_number" varchar(50),
	"return_id" varchar(30),
	"sender_name" varchar(255),
	"sender_company" varchar(255),
	"sender_email" varchar(255),
	"sender_phone" varchar(50),
	"sender_address" jsonb,
	"recipient_name" varchar(255),
	"recipient_company" varchar(255),
	"recipient_email" varchar(255),
	"recipient_phone" varchar(50),
	"recipient_address" jsonb,
	"weight" numeric(10, 3),
	"weight_unit" varchar(5) DEFAULT 'kg',
	"dimensions" jsonb,
	"package_type" varchar(20) DEFAULT 'parcel',
	"contents" text,
	"value" jsonb,
	"carrier_id" varchar(30),
	"carrier_name" varchar(255),
	"service_type" varchar(50),
	"service_level" varchar(50),
	"shipping_cost" jsonb,
	"insurance_amount" jsonb,
	"signature_required" boolean DEFAULT false,
	"saturday_delivery" boolean DEFAULT false,
	"shipped_at" timestamp,
	"estimated_delivery_date" timestamp,
	"actual_delivery_date" timestamp,
	"current_location" varchar(255),
	"last_scan_location" varchar(255),
	"last_scan_date" timestamp,
	"delivery_proof" jsonb,
	"label_url" varchar(500),
	"label_format" varchar(10),
	"invoice_url" varchar(500),
	"customs_form_url" varchar(500),
	"customs_info" jsonb,
	"is_return" boolean DEFAULT false,
	"return_label_url" varchar(500),
	"return_tracking_number" varchar(100),
	"tags" jsonb,
	"notes" text,
	"custom_fields" jsonb
);
--> statement-breakpoint
CREATE TABLE "shipments" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"shipment_number" varchar(50) NOT NULL,
	"status" varchar(30) DEFAULT 'draft' NOT NULL,
	"type" varchar(20) DEFAULT 'outbound' NOT NULL,
	"parcel_ids" jsonb,
	"total_parcels" integer DEFAULT 0,
	"carrier_id" varchar(30),
	"carrier_name" varchar(255),
	"service_type" varchar(50),
	"total_weight" numeric(10, 3),
	"total_cost" jsonb,
	"shipped_at" timestamp,
	"delivered_at" timestamp,
	"pickup_id" varchar(30),
	"pickup_date" timestamp,
	"pickup_time_window" jsonb,
	"manifest_url" varchar(500),
	"bol_url" varchar(500),
	"special_instructions" text,
	"internal_notes" text
);
--> statement-breakpoint
CREATE TABLE "tracking_events" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"parcel_id" varchar(30) NOT NULL,
	"tracking_number" varchar(100),
	"status" varchar(50) NOT NULL,
	"status_code" varchar(50),
	"description" text,
	"location" varchar(255),
	"city" varchar(100),
	"state" varchar(100),
	"country" varchar(100),
	"postal_code" varchar(20),
	"event_date" timestamp NOT NULL,
	"local_time" varchar(20),
	"timezone" varchar(50),
	"signatory" varchar(255),
	"exception" boolean DEFAULT false,
	"exception_reason" text,
	"source" varchar(20) DEFAULT 'carrier' NOT NULL,
	"raw_data" jsonb
);
--> statement-breakpoint
CREATE TABLE "pickups" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"pickup_number" varchar(50) NOT NULL,
	"status" varchar(30) DEFAULT 'scheduled' NOT NULL,
	"carrier_id" varchar(30) NOT NULL,
	"carrier_name" varchar(255),
	"confirmation_number" varchar(100),
	"pickup_date" timestamp NOT NULL,
	"time_window" jsonb,
	"pickup_address" jsonb,
	"contact_name" varchar(255),
	"contact_phone" varchar(50),
	"special_instructions" text,
	"shipment_ids" jsonb,
	"total_parcels" integer DEFAULT 0,
	"total_weight" numeric(10, 3),
	"pickup_cost" jsonb,
	"confirmed_at" timestamp,
	"cancelled_at" timestamp,
	"cancellation_reason" text
);
--> statement-breakpoint
CREATE TABLE "returns" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"return_number" varchar(50) NOT NULL,
	"status" varchar(30) DEFAULT 'requested' NOT NULL,
	"original_order_id" varchar(30),
	"original_tracking_number" varchar(100),
	"customer_id" varchar(30),
	"customer_name" varchar(255),
	"customer_email" varchar(255),
	"customer_phone" varchar(50),
	"reason" varchar(100),
	"reason_details" text,
	"condition" varchar(20),
	"items" jsonb,
	"return_parcel_id" varchar(30),
	"return_tracking_number" varchar(100),
	"return_label_url" varchar(500),
	"return_carrier" varchar(100),
	"return_method" varchar(20) DEFAULT 'label',
	"received_at" timestamp,
	"inspected_at" timestamp,
	"processed_at" timestamp,
	"resolution" jsonb,
	"refund_amount" jsonb,
	"replacement_order_id" varchar(30),
	"customer_notes" text,
	"internal_notes" text,
	"approval_status" varchar(20) DEFAULT 'pending',
	"approved_by" varchar(255),
	"approved_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "return_reason_groups" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"name" varchar(255) NOT NULL,
	"description" text,
	"display_order" integer DEFAULT 0,
	"is_active" boolean DEFAULT true,
	"color" varchar(20),
	"icon" varchar(50)
);
--> statement-breakpoint
CREATE TABLE "return_reasons" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"code" varchar(50) NOT NULL,
	"label" varchar(255) NOT NULL,
	"description" text,
	"group_id" varchar(30),
	"display_order" integer DEFAULT 0,
	"is_active" boolean DEFAULT true,
	"requires_photos" boolean DEFAULT false,
	"requires_details" boolean DEFAULT false,
	"auto_approve" boolean DEFAULT false,
	"refund_eligible" boolean DEFAULT true,
	"exchange_eligible" boolean DEFAULT true,
	"restocking_fee" numeric(5, 2),
	"usage_count" integer DEFAULT 0,
	"translations" jsonb
);
--> statement-breakpoint
CREATE TABLE "return_rules" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"name" varchar(255) NOT NULL,
	"description" text,
	"is_active" boolean DEFAULT true,
	"priority" integer DEFAULT 0,
	"conditions" jsonb,
	"condition_logic" varchar(10) DEFAULT 'all',
	"actions" jsonb,
	"return_window_days" integer DEFAULT 30,
	"usage_count" integer DEFAULT 0,
	"last_used_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "shipping_rules" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"name" varchar(255) NOT NULL,
	"description" text,
	"is_active" boolean DEFAULT true,
	"priority" integer DEFAULT 0,
	"conditions" jsonb,
	"condition_logic" varchar(10) DEFAULT 'all',
	"actions" jsonb,
	"usage_count" integer DEFAULT 0,
	"last_used_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "shipping_prices" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"name" varchar(255) NOT NULL,
	"carrier_id" varchar(30),
	"service_type" varchar(50),
	"from_zone" varchar(50),
	"to_zone" varchar(50),
	"weight_ranges" jsonb,
	"flat_rate" jsonb,
	"percentage_markup" numeric(5, 2),
	"handling_fee" jsonb,
	"fuel_surcharge" numeric(5, 2),
	"currency" varchar(3) DEFAULT 'EUR',
	"effective_from" timestamp,
	"effective_to" timestamp,
	"is_active" boolean DEFAULT true,
	"description" text
);
--> statement-breakpoint
CREATE TABLE "email_templates" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"name" varchar(255) NOT NULL,
	"subject" varchar(500) NOT NULL,
	"body" text,
	"html_body" text,
	"variables" jsonb,
	"trigger_event" varchar(50),
	"is_active" boolean DEFAULT true,
	"is_default" boolean DEFAULT false,
	"usage_count" integer DEFAULT 0,
	"last_used_at" timestamp,
	"description" text,
	"tags" jsonb
);
--> statement-breakpoint
CREATE TABLE "sms_templates" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"name" varchar(255) NOT NULL,
	"message" text NOT NULL,
	"max_length" integer DEFAULT 160,
	"variables" jsonb,
	"trigger_event" varchar(50),
	"is_active" boolean DEFAULT true,
	"is_default" boolean DEFAULT false,
	"usage_count" integer DEFAULT 0,
	"last_used_at" timestamp,
	"description" text,
	"tags" jsonb
);
--> statement-breakpoint
CREATE TABLE "whatsapp_templates" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"name" varchar(255) NOT NULL,
	"message" text NOT NULL,
	"header_text" varchar(255),
	"footer_text" varchar(255),
	"variables" jsonb,
	"media_type" varchar(20),
	"media_url" varchar(500),
	"buttons" jsonb,
	"trigger_event" varchar(50),
	"is_active" boolean DEFAULT true,
	"is_default" boolean DEFAULT false,
	"approval_status" varchar(20) DEFAULT 'pending',
	"usage_count" integer DEFAULT 0,
	"last_used_at" timestamp,
	"description" text,
	"tags" jsonb
);
--> statement-breakpoint
CREATE TABLE "wallet_transactions" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"wallet_id" varchar(30) NOT NULL,
	"user_id" varchar(255),
	"type" varchar(30) NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"currency" varchar(3) DEFAULT 'EUR',
	"balance_before" numeric(18, 2),
	"balance_after" numeric(18, 2),
	"reference_type" varchar(50),
	"reference_id" varchar(30),
	"description" text,
	"notes" text,
	"metadata" jsonb,
	"processed_by" varchar(255),
	"processed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "wallets" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"user_id" varchar(255),
	"user_name" varchar(255),
	"balance" numeric(18, 2) DEFAULT '0' NOT NULL,
	"currency" varchar(3) DEFAULT 'EUR',
	"credit_limit" numeric(18, 2),
	"low_balance_threshold" numeric(18, 2),
	"is_active" boolean DEFAULT true,
	"is_frozen" boolean DEFAULT false,
	"total_credits" numeric(18, 2) DEFAULT '0',
	"total_debits" numeric(18, 2) DEFAULT '0',
	"transaction_count" integer DEFAULT 0,
	"last_transaction_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "helpdesk_analytics_charts" ADD CONSTRAINT "helpdesk_analytics_charts_report_id_helpdesk_analytics_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."helpdesk_analytics_reports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "helpdesk_analytics_reports_workspace_idx" ON "helpdesk_analytics_reports" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "helpdesk_analytics_charts_workspace_idx" ON "helpdesk_analytics_charts" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "helpdesk_analytics_charts_report_idx" ON "helpdesk_analytics_charts" USING btree ("report_id");--> statement-breakpoint
CREATE INDEX "carriers_workspace_idx" ON "carriers" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "carriers_code_idx" ON "carriers" USING btree ("code");--> statement-breakpoint
CREATE INDEX "carriers_is_active_idx" ON "carriers" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "carrier_services_workspace_idx" ON "carrier_services" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "carrier_services_carrier_id_idx" ON "carrier_services" USING btree ("carrier_id");--> statement-breakpoint
CREATE INDEX "carrier_services_code_idx" ON "carrier_services" USING btree ("code");--> statement-breakpoint
CREATE INDEX "carrier_services_is_active_idx" ON "carrier_services" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "boxes_workspace_idx" ON "boxes" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "boxes_code_idx" ON "boxes" USING btree ("code");--> statement-breakpoint
CREATE INDEX "boxes_is_active_idx" ON "boxes" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "parcels_workspace_idx" ON "parcels" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "parcels_tracking_number_idx" ON "parcels" USING btree ("tracking_number");--> statement-breakpoint
CREATE INDEX "parcels_status_idx" ON "parcels" USING btree ("status");--> statement-breakpoint
CREATE INDEX "parcels_carrier_id_idx" ON "parcels" USING btree ("carrier_id");--> statement-breakpoint
CREATE INDEX "parcels_shipment_id_idx" ON "parcels" USING btree ("shipment_id");--> statement-breakpoint
CREATE INDEX "parcels_order_id_idx" ON "parcels" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "parcels_order_number_idx" ON "parcels" USING btree ("order_number");--> statement-breakpoint
CREATE INDEX "parcels_created_at_idx" ON "parcels" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "shipments_workspace_idx" ON "shipments" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "shipments_shipment_number_idx" ON "shipments" USING btree ("shipment_number");--> statement-breakpoint
CREATE INDEX "shipments_status_idx" ON "shipments" USING btree ("status");--> statement-breakpoint
CREATE INDEX "shipments_carrier_id_idx" ON "shipments" USING btree ("carrier_id");--> statement-breakpoint
CREATE INDEX "shipments_created_at_idx" ON "shipments" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "tracking_events_workspace_idx" ON "tracking_events" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "tracking_events_parcel_id_idx" ON "tracking_events" USING btree ("parcel_id");--> statement-breakpoint
CREATE INDEX "tracking_events_tracking_number_idx" ON "tracking_events" USING btree ("tracking_number");--> statement-breakpoint
CREATE INDEX "tracking_events_event_date_idx" ON "tracking_events" USING btree ("event_date");--> statement-breakpoint
CREATE INDEX "pickups_workspace_idx" ON "pickups" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "pickups_pickup_number_idx" ON "pickups" USING btree ("pickup_number");--> statement-breakpoint
CREATE INDEX "pickups_status_idx" ON "pickups" USING btree ("status");--> statement-breakpoint
CREATE INDEX "pickups_carrier_id_idx" ON "pickups" USING btree ("carrier_id");--> statement-breakpoint
CREATE INDEX "pickups_pickup_date_idx" ON "pickups" USING btree ("pickup_date");--> statement-breakpoint
CREATE INDEX "returns_workspace_idx" ON "returns" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "returns_return_number_idx" ON "returns" USING btree ("return_number");--> statement-breakpoint
CREATE INDEX "returns_status_idx" ON "returns" USING btree ("status");--> statement-breakpoint
CREATE INDEX "returns_customer_id_idx" ON "returns" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "returns_original_order_id_idx" ON "returns" USING btree ("original_order_id");--> statement-breakpoint
CREATE INDEX "returns_created_at_idx" ON "returns" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "return_reason_groups_workspace_idx" ON "return_reason_groups" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "return_reason_groups_is_active_idx" ON "return_reason_groups" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "return_reasons_workspace_idx" ON "return_reasons" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "return_reasons_code_idx" ON "return_reasons" USING btree ("code");--> statement-breakpoint
CREATE INDEX "return_reasons_group_id_idx" ON "return_reasons" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "return_reasons_is_active_idx" ON "return_reasons" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "return_rules_workspace_idx" ON "return_rules" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "return_rules_is_active_idx" ON "return_rules" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "return_rules_priority_idx" ON "return_rules" USING btree ("priority");--> statement-breakpoint
CREATE INDEX "shipping_rules_workspace_idx" ON "shipping_rules" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "shipping_rules_is_active_idx" ON "shipping_rules" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "shipping_rules_priority_idx" ON "shipping_rules" USING btree ("priority");--> statement-breakpoint
CREATE INDEX "shipping_prices_workspace_idx" ON "shipping_prices" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "shipping_prices_carrier_id_idx" ON "shipping_prices" USING btree ("carrier_id");--> statement-breakpoint
CREATE INDEX "shipping_prices_is_active_idx" ON "shipping_prices" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "email_templates_workspace_idx" ON "email_templates" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "email_templates_trigger_event_idx" ON "email_templates" USING btree ("trigger_event");--> statement-breakpoint
CREATE INDEX "email_templates_is_active_idx" ON "email_templates" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "sms_templates_workspace_idx" ON "sms_templates" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "sms_templates_trigger_event_idx" ON "sms_templates" USING btree ("trigger_event");--> statement-breakpoint
CREATE INDEX "sms_templates_is_active_idx" ON "sms_templates" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "whatsapp_templates_workspace_idx" ON "whatsapp_templates" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "whatsapp_templates_trigger_event_idx" ON "whatsapp_templates" USING btree ("trigger_event");--> statement-breakpoint
CREATE INDEX "whatsapp_templates_is_active_idx" ON "whatsapp_templates" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "wallet_transactions_workspace_idx" ON "wallet_transactions" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "wallet_transactions_wallet_id_idx" ON "wallet_transactions" USING btree ("wallet_id");--> statement-breakpoint
CREATE INDEX "wallet_transactions_user_id_idx" ON "wallet_transactions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "wallet_transactions_type_idx" ON "wallet_transactions" USING btree ("type");--> statement-breakpoint
CREATE INDEX "wallet_transactions_created_at_idx" ON "wallet_transactions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "wallets_workspace_idx" ON "wallets" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "wallets_user_id_idx" ON "wallets" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "wallets_is_active_idx" ON "wallets" USING btree ("is_active");