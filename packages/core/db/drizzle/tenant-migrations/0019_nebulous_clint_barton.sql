CREATE TABLE "contact_customers" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"contact_id" varchar(30) NOT NULL,
	"customer_id" varchar(30) NOT NULL,
	"is_primary" boolean DEFAULT false,
	"role" varchar(50),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contact_suppliers" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"contact_id" varchar(30) NOT NULL,
	"supplier_id" varchar(30) NOT NULL,
	"is_primary" boolean DEFAULT false,
	"role" varchar(50),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contacts" ALTER COLUMN "customer_id" DROP NOT NULL;--> statement-breakpoint
CREATE INDEX "contact_customers_contact_idx" ON "contact_customers" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "contact_customers_customer_idx" ON "contact_customers" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contact_customers_unique" ON "contact_customers" USING btree ("contact_id","customer_id");--> statement-breakpoint
CREATE INDEX "contact_suppliers_contact_idx" ON "contact_suppliers" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "contact_suppliers_supplier_idx" ON "contact_suppliers" USING btree ("supplier_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contact_suppliers_unique" ON "contact_suppliers" USING btree ("contact_id","supplier_id");