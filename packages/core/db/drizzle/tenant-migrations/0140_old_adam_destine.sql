DROP INDEX "companies_is_customer_idx";--> statement-breakpoint
DROP INDEX "people_is_customer_idx";--> statement-breakpoint
ALTER TABLE "contact_external_identities" ADD COLUMN "person_id" varchar(30);--> statement-breakpoint
CREATE INDEX "contact_ext_id_person_idx" ON "contact_external_identities" USING btree ("person_id");--> statement-breakpoint
ALTER TABLE "companies" DROP COLUMN "is_customer";--> statement-breakpoint
ALTER TABLE "people" DROP COLUMN "is_customer";