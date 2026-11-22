ALTER TABLE "people" ADD COLUMN "in_crm" boolean DEFAULT true NOT NULL;--> statement-breakpoint
CREATE INDEX "people_in_crm_idx" ON "people" USING btree ("in_crm");