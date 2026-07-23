CREATE TABLE "vies_checks" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"vat_number" varchar(20) NOT NULL,
	"country_code" varchar(2) NOT NULL,
	"valid" boolean NOT NULL,
	"trader_name" varchar(255),
	"trader_address" varchar(500),
	"consultation_number" varchar(50),
	"checked_at" timestamp NOT NULL,
	CONSTRAINT "vies_checks_vat_number_unique" UNIQUE("vat_number")
);
--> statement-breakpoint
CREATE TABLE "icp_declarations" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"entity_id" varchar(30) NOT NULL,
	"period_type" varchar(10) NOT NULL,
	"period_start" timestamp NOT NULL,
	"period_end" timestamp NOT NULL,
	"period_label" varchar(50),
	"status" varchar(15) DEFAULT 'calculated' NOT NULL,
	"total_amount" numeric(15, 2) DEFAULT '0' NOT NULL,
	"xml_content" text,
	"filing_reference" varchar(100),
	"digipoort_response" jsonb,
	"filed_at" timestamp,
	"filed_by" varchar(255),
	"accepted_at" timestamp,
	"rejected_at" timestamp,
	"rejection_reason" text,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "icp_lines" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"declaration_id" varchar(30) NOT NULL,
	"entity_id" varchar(30) NOT NULL,
	"contact_id" varchar(30),
	"vat_number" varchar(20) NOT NULL,
	"country_code" varchar(2) NOT NULL,
	"supply_type" varchar(15) DEFAULT 'goods' NOT NULL,
	"amount" numeric(15, 2) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "commerce_cart_items" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "commerce_carts" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "commerce_discount_usage" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "commerce_discounts" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "woocommerce_connections" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "woocommerce_customers" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "woocommerce_orders" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "woocommerce_products" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "shopify_connections" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "shopify_collections" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "shopify_customers" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "shopify_fulfillments" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "shopify_orders" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "shopify_products" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "shopify_variants" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "commerce_websites" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "commerce_website_pages" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "commerce_website_sections" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "commerce_website_domains" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "commerce_cart_items" CASCADE;--> statement-breakpoint
DROP TABLE "commerce_carts" CASCADE;--> statement-breakpoint
DROP TABLE "commerce_discount_usage" CASCADE;--> statement-breakpoint
DROP TABLE "commerce_discounts" CASCADE;--> statement-breakpoint
DROP TABLE "woocommerce_connections" CASCADE;--> statement-breakpoint
DROP TABLE "woocommerce_customers" CASCADE;--> statement-breakpoint
DROP TABLE "woocommerce_orders" CASCADE;--> statement-breakpoint
DROP TABLE "woocommerce_products" CASCADE;--> statement-breakpoint
DROP TABLE "shopify_connections" CASCADE;--> statement-breakpoint
DROP TABLE "shopify_collections" CASCADE;--> statement-breakpoint
DROP TABLE "shopify_customers" CASCADE;--> statement-breakpoint
DROP TABLE "shopify_fulfillments" CASCADE;--> statement-breakpoint
DROP TABLE "shopify_orders" CASCADE;--> statement-breakpoint
DROP TABLE "shopify_products" CASCADE;--> statement-breakpoint
DROP TABLE "shopify_variants" CASCADE;--> statement-breakpoint
DROP TABLE "commerce_websites" CASCADE;--> statement-breakpoint
DROP TABLE "commerce_website_pages" CASCADE;--> statement-breakpoint
DROP TABLE "commerce_website_sections" CASCADE;--> statement-breakpoint
DROP TABLE "commerce_website_domains" CASCADE;--> statement-breakpoint
ALTER TABLE "roles" ADD COLUMN "apps" jsonb DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "vat_returns" ADD COLUMN "suppletie_deadline" timestamp;--> statement-breakpoint
CREATE INDEX "acct_vies_checks_country_idx" ON "vies_checks" USING btree ("country_code");--> statement-breakpoint
CREATE INDEX "acct_vies_checks_checked_at_idx" ON "vies_checks" USING btree ("checked_at");--> statement-breakpoint
CREATE INDEX "acct_icp_declarations_entity_idx" ON "icp_declarations" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "acct_icp_declarations_period_idx" ON "icp_declarations" USING btree ("period_start","period_end");--> statement-breakpoint
CREATE INDEX "acct_icp_declarations_status_idx" ON "icp_declarations" USING btree ("status");--> statement-breakpoint
CREATE INDEX "acct_icp_lines_declaration_idx" ON "icp_lines" USING btree ("declaration_id");--> statement-breakpoint
CREATE INDEX "acct_icp_lines_entity_idx" ON "icp_lines" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "acct_icp_lines_vat_number_idx" ON "icp_lines" USING btree ("vat_number");