ALTER TABLE "invoice_items" ADD COLUMN "hsn_sac" varchar(10);--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "place_of_supply" varchar(2);--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "contact_tax_number" varchar(50);--> statement-breakpoint
UPDATE "accounts" SET "subtype" = 'sales' WHERE "subtype" = 'other_income' AND "code" IN ('8000', '8010', '8500') AND "entity_id" IN (SELECT "id" FROM "entities" WHERE "jurisdiction_code" IN ('NL', 'IN'));--> statement-breakpoint
UPDATE "accounts" SET "subtype" = 'service_revenue' WHERE "subtype" = 'other_income' AND "code" IN ('8020', '8030') AND "entity_id" IN (SELECT "id" FROM "entities" WHERE "jurisdiction_code" IN ('NL', 'IN'));--> statement-breakpoint
UPDATE "accounts" SET "subtype" = 'cost_of_goods_sold' WHERE "subtype" = 'cost_of_goods' AND "code" IN ('4000', '4010') AND "entity_id" IN (SELECT "id" FROM "entities" WHERE "jurisdiction_code" IN ('NL', 'IN'));
