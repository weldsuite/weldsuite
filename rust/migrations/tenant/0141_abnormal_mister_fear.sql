ALTER TABLE "contact_customers" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "contact_suppliers" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "contact_list_members" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "customer_list_members" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "customer_lists" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "customer_import_jobs" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "contact_customers" CASCADE;--> statement-breakpoint
DROP TABLE "contact_suppliers" CASCADE;--> statement-breakpoint
DROP TABLE "contact_list_members" CASCADE;--> statement-breakpoint
DROP TABLE "customer_list_members" CASCADE;--> statement-breakpoint
DROP TABLE "customer_lists" CASCADE;--> statement-breakpoint
DROP TABLE "customer_import_jobs" CASCADE;--> statement-breakpoint
DROP INDEX "contact_ext_id_contact_idx";--> statement-breakpoint
ALTER TABLE "contact_external_identities" DROP COLUMN "contact_id";