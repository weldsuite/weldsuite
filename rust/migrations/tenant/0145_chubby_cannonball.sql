CREATE TABLE "crm_templates" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"entity_type" varchar(50) NOT NULL,
	"name" varchar(150) NOT NULL,
	"slug" varchar(150) NOT NULL,
	"description" varchar(500),
	"fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX "crm_templates_entity_type_idx" ON "crm_templates" USING btree ("entity_type");--> statement-breakpoint
CREATE UNIQUE INDEX "crm_templates_entity_type_slug_idx" ON "crm_templates" USING btree ("entity_type","slug");