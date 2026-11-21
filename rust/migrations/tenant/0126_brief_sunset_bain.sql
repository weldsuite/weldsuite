CREATE TABLE "crm_customer_statuses" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"name" varchar(60) NOT NULL,
	"slug" varchar(30) NOT NULL,
	"color" varchar(30) DEFAULT 'gray' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "crm_customer_statuses_slug_uniq" ON "crm_customer_statuses" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "crm_customer_statuses_sort_idx" ON "crm_customer_statuses" USING btree ("sort_order");