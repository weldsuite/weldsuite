CREATE TABLE "project_sheets" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"project_id" varchar(255) NOT NULL,
	"name" varchar(255) NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"settings" jsonb
);
--> statement-breakpoint
CREATE TABLE "project_sheet_columns" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"sheet_id" varchar(255) NOT NULL,
	"name" varchar(255) NOT NULL,
	"field_type" varchar(50) NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"width" integer DEFAULT 150,
	"options" jsonb,
	"config" jsonb
);
--> statement-breakpoint
CREATE TABLE "project_sheet_rows" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"sheet_id" varchar(255) NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE INDEX "project_sheets_project_idx" ON "project_sheets" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "project_sheet_columns_sheet_idx" ON "project_sheet_columns" USING btree ("sheet_id");--> statement-breakpoint
CREATE INDEX "project_sheet_rows_sheet_pos_idx" ON "project_sheet_rows" USING btree ("sheet_id","position");