CREATE TABLE "voip_porting_orders" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"created_by_user_id" varchar(255) NOT NULL,
	"phone_number" varchar(50) NOT NULL,
	"formatted_number" varchar(50),
	"country_code" varchar(5) NOT NULL,
	"number_type" varchar(20) DEFAULT 'local' NOT NULL,
	"telnyx_porting_order_id" varchar(100),
	"status" varchar(30) DEFAULT 'draft' NOT NULL,
	"substatus" varchar(100),
	"requested_foc_at" timestamp,
	"actual_foc_at" timestamp,
	"authorized_name" varchar(200),
	"business_name" varchar(200),
	"service_address" jsonb,
	"current_carrier" varchar(100),
	"current_account_number" varchar(100),
	"current_pin" varchar(50),
	"loa_storage_key" varchar(500),
	"bill_copy_storage_key" varchar(500),
	"stripe_price_id" varchar(255),
	"billing_activated" boolean DEFAULT false NOT NULL,
	"billing_error" text,
	"last_error_code" varchar(80),
	"last_error_message" text,
	"voip_phone_number_id" varchar(30),
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE UNIQUE INDEX "voip_porting_orders_telnyx_id_idx" ON "voip_porting_orders" USING btree ("telnyx_porting_order_id") WHERE "voip_porting_orders"."telnyx_porting_order_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "voip_porting_orders_active_phone_idx" ON "voip_porting_orders" USING btree ("phone_number") WHERE "voip_porting_orders"."deleted_at" IS NULL AND "voip_porting_orders"."status" NOT IN ('cancelled','exception','preflight_failed','completed');--> statement-breakpoint
CREATE INDEX "voip_porting_orders_status_idx" ON "voip_porting_orders" USING btree ("status");--> statement-breakpoint
CREATE INDEX "voip_porting_orders_phone_idx" ON "voip_porting_orders" USING btree ("phone_number");--> statement-breakpoint
CREATE INDEX "voip_porting_orders_created_by_idx" ON "voip_porting_orders" USING btree ("created_by_user_id");