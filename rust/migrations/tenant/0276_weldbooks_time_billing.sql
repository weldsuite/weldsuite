ALTER TABLE "invoice_items" ADD COLUMN "project_id" varchar(30);--> statement-breakpoint
ALTER TABLE "time_entries" ADD COLUMN "invoice_id" varchar(30);--> statement-breakpoint
ALTER TABLE "time_entries" ADD COLUMN "invoice_item_id" varchar(30);--> statement-breakpoint
CREATE INDEX "acct_invoice_items_project_idx" ON "invoice_items" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "time_entries_invoice_idx" ON "time_entries" USING btree ("invoice_id");