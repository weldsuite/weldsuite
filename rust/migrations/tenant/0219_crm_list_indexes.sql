-- pg_trgm must exist before the two gin_trgm_ops search indexes below.
-- drizzle-kit does not emit extension statements, so this line is hand-added;
-- keep it at the top if this migration is ever regenerated.
-- Available on every Neon plan, no add-on required.
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE INDEX "companies_live_created_idx" ON "companies" USING btree ("created_at","id") WHERE "companies"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "companies_live_name_idx" ON "companies" USING btree (lower("display_name"::text),"id") WHERE "companies"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "companies_search_trgm_idx" ON "companies" USING gin ((coalesce("display_name", '') || E'\n' || coalesce("name", '') || E'\n' || coalesce("trading_name", '') || E'\n' || coalesce("email", '') || E'\n' || coalesce("vat_number", '')) gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "people_live_created_idx" ON "people" USING btree ("created_at","id","in_crm") WHERE "people"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "people_live_name_idx" ON "people" USING btree (lower("display_name"::text),"id") WHERE "people"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "people_search_trgm_idx" ON "people" USING gin ((coalesce("display_name", '') || E'\n' || coalesce("full_name", '') || E'\n' || coalesce("first_name", '') || E'\n' || coalesce("last_name", '') || E'\n' || coalesce("email", '')) gin_trgm_ops);