ALTER TABLE "customers" RENAME TO "parties";--> statement-breakpoint
ALTER TABLE "parties" DROP CONSTRAINT "customers_customer_code_unique";--> statement-breakpoint
DROP INDEX "customers_email_idx";--> statement-breakpoint
DROP INDEX "customers_customer_code_idx";--> statement-breakpoint
DROP INDEX "customers_type_idx";--> statement-breakpoint
DROP INDEX "customers_status_idx";--> statement-breakpoint
DROP INDEX "customers_owner_idx";--> statement-breakpoint
DROP INDEX "customers_company_name_idx";--> statement-breakpoint
ALTER TABLE "parties" ADD COLUMN "role" varchar(20) DEFAULT 'customer' NOT NULL;--> statement-breakpoint
CREATE INDEX "parties_email_idx" ON "parties" USING btree ("email");--> statement-breakpoint
CREATE INDEX "parties_customer_code_idx" ON "parties" USING btree ("customer_code");--> statement-breakpoint
CREATE INDEX "parties_type_idx" ON "parties" USING btree ("type");--> statement-breakpoint
CREATE INDEX "parties_status_idx" ON "parties" USING btree ("status");--> statement-breakpoint
CREATE INDEX "parties_owner_idx" ON "parties" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "parties_company_name_idx" ON "parties" USING btree ("company_name");--> statement-breakpoint
CREATE INDEX "parties_role_idx" ON "parties" USING btree ("role");--> statement-breakpoint
ALTER TABLE "parties" ADD CONSTRAINT "parties_customer_code_unique" UNIQUE("customer_code");