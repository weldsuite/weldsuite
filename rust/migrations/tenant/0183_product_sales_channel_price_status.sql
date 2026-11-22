ALTER TABLE "product_sales_channels" ADD COLUMN "price" numeric(18, 2);--> statement-breakpoint
ALTER TABLE "product_sales_channels" ADD COLUMN "listing_status" varchar(20) DEFAULT 'active' NOT NULL;
