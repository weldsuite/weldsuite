CREATE TABLE "custom_field_definitions" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"entity_type" varchar(50) NOT NULL,
	"name" varchar(100) NOT NULL,
	"slug" varchar(100) NOT NULL,
	"description" varchar(500),
	"field_type" varchar(30) NOT NULL,
	"options" jsonb,
	"config" jsonb,
	"required" boolean DEFAULT false,
	"sort_order" integer DEFAULT 0,
	"group" varchar(100)
);
--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "custom_fields" jsonb;--> statement-breakpoint
CREATE INDEX "cfd_entity_type_idx" ON "custom_field_definitions" USING btree ("entity_type");--> statement-breakpoint
CREATE UNIQUE INDEX "cfd_entity_type_slug_idx" ON "custom_field_definitions" USING btree ("entity_type","slug");