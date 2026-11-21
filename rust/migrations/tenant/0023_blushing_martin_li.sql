ALTER TABLE "customers" ADD COLUMN "customer_code" varchar(50);--> statement-breakpoint
CREATE INDEX "customers_customer_code_idx" ON "customers" USING btree ("customer_code");--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_customer_code_unique" UNIQUE("customer_code");