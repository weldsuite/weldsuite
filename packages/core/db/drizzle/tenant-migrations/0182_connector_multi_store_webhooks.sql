DROP INDEX IF EXISTS "connector_connections_provider_unique";--> statement-breakpoint
ALTER TABLE "connector_connections" ADD COLUMN "webhook_secret" text;--> statement-breakpoint
ALTER TABLE "connector_connections" ADD COLUMN "webhook_registrations" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "connector_connections_provider_account_live_unique" ON "connector_connections" ("provider", "external_account_id") WHERE "deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "connector_connections_provider_idx" ON "connector_connections" USING btree ("provider");--> statement-breakpoint
CREATE TABLE "product_sales_channels" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"product_id" varchar(30) NOT NULL,
	"connection_id" varchar(30) NOT NULL,
	"provider" varchar(100) NOT NULL,
	"display_name" varchar(255),
	"external_id" varchar(255) NOT NULL,
	"external_url" varchar(500),
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"last_synced_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "product_sales_channels" ADD CONSTRAINT "product_sales_channels_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_sales_channels" ADD CONSTRAINT "product_sales_channels_connection_id_connector_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connector_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "product_sales_channels_connection_external_unique" ON "product_sales_channels" USING btree ("connection_id","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "product_sales_channels_product_connection_unique" ON "product_sales_channels" USING btree ("product_id","connection_id");--> statement-breakpoint
CREATE INDEX "product_sales_channels_product_idx" ON "product_sales_channels" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "product_sales_channels_connection_idx" ON "product_sales_channels" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "product_sales_channels_provider_idx" ON "product_sales_channels" USING btree ("provider");
