CREATE TABLE "iceberg_namespace_properties" (
	"catalog_name" varchar(255) NOT NULL,
	"namespace" varchar(255) NOT NULL,
	"property_key" varchar(255) NOT NULL,
	"property_value" varchar(1000),
	CONSTRAINT "iceberg_namespace_properties_pkey" PRIMARY KEY("catalog_name","namespace","property_key")
);
--> statement-breakpoint
CREATE TABLE "iceberg_tables" (
	"catalog_name" varchar(255) NOT NULL,
	"table_namespace" varchar(255) NOT NULL,
	"table_name" varchar(255) NOT NULL,
	"metadata_location" varchar(1000),
	"previous_metadata_location" varchar(1000),
	"iceberg_type" varchar(5),
	CONSTRAINT "iceberg_tables_pkey" PRIMARY KEY("catalog_name","table_namespace","table_name")
);
--> statement-breakpoint
CREATE TABLE "panel_erasure_ledger" (
	"workspace_id" varchar(255) NOT NULL,
	"project_id" varchar(30) NOT NULL,
	"erased_id" text NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_at" timestamp with time zone,
	CONSTRAINT "panel_erasure_ledger_project_id_erased_id_pk" PRIMARY KEY("project_id","erased_id")
);
--> statement-breakpoint
CREATE INDEX "panel_erasure_ledger_pending_idx" ON "panel_erasure_ledger" USING btree ("requested_at") WHERE "panel_erasure_ledger"."applied_at" IS NULL;--> statement-breakpoint
CREATE INDEX "panel_erasure_ledger_workspace_idx" ON "panel_erasure_ledger" USING btree ("workspace_id");