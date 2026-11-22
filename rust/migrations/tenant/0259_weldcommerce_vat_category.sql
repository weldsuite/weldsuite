ALTER TABLE "products" ADD COLUMN "vat_category" varchar(20) DEFAULT 'standard' NOT NULL;--> statement-breakpoint
ALTER TABLE "product_variants" ADD COLUMN "vat_category" varchar(20);