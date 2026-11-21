ALTER TABLE "contacts" ADD COLUMN "visitor_id" varchar(100);--> statement-breakpoint
CREATE INDEX "contacts_visitor_id_idx" ON "contacts" USING btree ("visitor_id");