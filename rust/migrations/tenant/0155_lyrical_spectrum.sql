CREATE TABLE "welddata_cells" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"column_id" varchar(30) NOT NULL,
	"lead_id" varchar(30) NOT NULL,
	"status" varchar(10) DEFAULT 'pending' NOT NULL,
	"value" text,
	"data" jsonb,
	"error" text,
	"credits_used" integer,
	"ran_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "welddata_columns" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"list_id" varchar(30) NOT NULL,
	"name" varchar(255) NOT NULL,
	"type" varchar(30) DEFAULT 'ai' NOT NULL,
	"config" jsonb,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_by" varchar(255)
);
--> statement-breakpoint
CREATE TABLE "welddata_leads" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"list_id" varchar(30) NOT NULL,
	"added_by" varchar(255),
	"kind" varchar(10) NOT NULL,
	"lemlist_id" varchar(255),
	"data" jsonb,
	"name" varchar(255),
	"email" varchar(255),
	"title" varchar(255),
	"company_name" varchar(255),
	"domain" varchar(255),
	"industry" varchar(255),
	"location" varchar(255),
	"country" varchar(100),
	"company_size" varchar(50),
	"linkedin_url" varchar(500),
	"converted_status" varchar(10) DEFAULT 'pending' NOT NULL,
	"converted_at" timestamp,
	"converted_person_id" varchar(30),
	"converted_company_id" varchar(30)
);
--> statement-breakpoint
CREATE TABLE "welddata_lists" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"name" varchar(255) NOT NULL,
	"description" varchar(1000),
	"color" varchar(50) DEFAULT 'bg-blue-500' NOT NULL,
	"icon" varchar(100) DEFAULT 'Database' NOT NULL,
	"created_by" varchar(255)
);
--> statement-breakpoint
CREATE INDEX "welddata_cells_column_idx" ON "welddata_cells" USING btree ("column_id");--> statement-breakpoint
CREATE INDEX "welddata_cells_lead_idx" ON "welddata_cells" USING btree ("lead_id");--> statement-breakpoint
CREATE UNIQUE INDEX "welddata_cells_column_lead_unique" ON "welddata_cells" USING btree ("column_id","lead_id");--> statement-breakpoint
CREATE INDEX "welddata_columns_list_idx" ON "welddata_columns" USING btree ("list_id");--> statement-breakpoint
CREATE INDEX "welddata_columns_deleted_at_idx" ON "welddata_columns" USING btree ("deleted_at");--> statement-breakpoint
CREATE INDEX "welddata_leads_list_idx" ON "welddata_leads" USING btree ("list_id");--> statement-breakpoint
CREATE INDEX "welddata_leads_converted_status_idx" ON "welddata_leads" USING btree ("converted_status");--> statement-breakpoint
CREATE INDEX "welddata_leads_deleted_at_idx" ON "welddata_leads" USING btree ("deleted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "welddata_leads_list_lemlist_unique" ON "welddata_leads" USING btree ("list_id","kind","lemlist_id");--> statement-breakpoint
CREATE INDEX "welddata_lists_name_idx" ON "welddata_lists" USING btree ("name");--> statement-breakpoint
CREATE INDEX "welddata_lists_deleted_at_idx" ON "welddata_lists" USING btree ("deleted_at");