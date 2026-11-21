ALTER TABLE "parties" RENAME COLUMN "customer_code" TO "party_code";--> statement-breakpoint
ALTER TABLE "parties" RENAME COLUMN "parent_customer_id" TO "parent_party_id";--> statement-breakpoint
ALTER TABLE "parties" RENAME COLUMN "customer_since" TO "relationship_since";--> statement-breakpoint
ALTER TABLE "parties" DROP CONSTRAINT "parties_customer_code_unique";--> statement-breakpoint
DROP INDEX "parties_customer_code_idx";--> statement-breakpoint
CREATE INDEX "parties_party_code_idx" ON "parties" USING btree ("party_code");--> statement-breakpoint
ALTER TABLE "parties" ADD CONSTRAINT "parties_party_code_unique" UNIQUE("party_code");