CREATE TABLE "sheet_versions" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"sheet_id" varchar(255) NOT NULL,
	"revision" integer NOT NULL,
	"name" varchar(255),
	"snapshot_key" varchar(1000) NOT NULL,
	"size" integer DEFAULT 0 NOT NULL,
	"created_by_id" varchar(255)
);
--> statement-breakpoint
CREATE TABLE "sheet_data_sources" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"sheet_id" varchar(255) NOT NULL,
	"object_type" varchar(50) NOT NULL,
	"definition" jsonb NOT NULL,
	"refresh" varchar(20) DEFAULT 'manual' NOT NULL,
	"last_refreshed_at" timestamp,
	"next_refresh_at" timestamp,
	"last_error" text,
	"row_count" integer DEFAULT 0 NOT NULL,
	"created_by_id" varchar(255) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sheet_versions" ADD CONSTRAINT "sheet_versions_sheet_id_sheets_id_fk" FOREIGN KEY ("sheet_id") REFERENCES "public"."sheets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sheet_data_sources" ADD CONSTRAINT "sheet_data_sources_sheet_id_sheets_id_fk" FOREIGN KEY ("sheet_id") REFERENCES "public"."sheets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sheet_versions_sheet_idx" ON "sheet_versions" USING btree ("sheet_id","created_at");--> statement-breakpoint
CREATE INDEX "sheet_data_sources_sheet_idx" ON "sheet_data_sources" USING btree ("sheet_id");--> statement-breakpoint
ALTER TABLE "sheets" DROP COLUMN "snapshot";