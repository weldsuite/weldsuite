CREATE TABLE "custom_object_links" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"slug" varchar(50) NOT NULL,
	"source_entity_key" varchar(30) NOT NULL,
	"target_entity_key" varchar(30) NOT NULL,
	"cardinality" varchar(20) NOT NULL,
	"source_label" varchar(100) NOT NULL,
	"target_label" varchar(100) NOT NULL,
	"on_delete" varchar(20) DEFAULT 'set_null' NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "custom_object_records" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"object_id" varchar(30) NOT NULL,
	"entity_key" varchar(30) NOT NULL,
	"title" varchar(500),
	"owner_id" varchar(255),
	"created_by" varchar(255),
	"updated_by" varchar(255)
);
--> statement-breakpoint
CREATE TABLE "custom_object_relations" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"created_by" varchar(255),
	"link_id" varchar(30) NOT NULL,
	"source_entity_key" varchar(30) NOT NULL,
	"source_id" varchar(30) NOT NULL,
	"target_entity_key" varchar(30) NOT NULL,
	"target_id" varchar(30) NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "custom_objects" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"slug" varchar(24) NOT NULL,
	"entity_key" varchar(30) NOT NULL,
	"label_singular" varchar(100) NOT NULL,
	"label_plural" varchar(100) NOT NULL,
	"description" varchar(500),
	"icon" varchar(50) DEFAULT 'Box' NOT NULL,
	"color" varchar(20),
	"title_field_id" varchar(30),
	"status" varchar(20) DEFAULT 'draft' NOT NULL,
	"enable_events" boolean DEFAULT true NOT NULL,
	"enable_search" boolean DEFAULT false NOT NULL,
	"enable_agent_tools" boolean DEFAULT false NOT NULL,
	"enable_external_api" boolean DEFAULT false NOT NULL,
	"list_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_by" varchar(255)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "col_source_slug_idx" ON "custom_object_links" USING btree ("source_entity_key","slug") WHERE "custom_object_links"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "col_source_idx" ON "custom_object_links" USING btree ("source_entity_key");--> statement-breakpoint
CREATE INDEX "col_target_idx" ON "custom_object_links" USING btree ("target_entity_key");--> statement-breakpoint
CREATE INDEX "cor_entity_key_created_idx" ON "custom_object_records" USING btree ("entity_key","created_at");--> statement-breakpoint
CREATE INDEX "cor_entity_key_owner_idx" ON "custom_object_records" USING btree ("entity_key","owner_id");--> statement-breakpoint
CREATE INDEX "cor_entity_key_title_idx" ON "custom_object_records" USING btree ("entity_key","title");--> statement-breakpoint
CREATE INDEX "cor_object_id_idx" ON "custom_object_records" USING btree ("object_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cor_rel_link_source_target_idx" ON "custom_object_relations" USING btree ("link_id","source_id","target_id");--> statement-breakpoint
CREATE INDEX "cor_rel_link_source_idx" ON "custom_object_relations" USING btree ("link_id","source_id");--> statement-breakpoint
CREATE INDEX "cor_rel_link_target_idx" ON "custom_object_relations" USING btree ("link_id","target_id");--> statement-breakpoint
CREATE INDEX "cor_rel_target_idx" ON "custom_object_relations" USING btree ("target_entity_key","target_id");--> statement-breakpoint
CREATE UNIQUE INDEX "custom_objects_slug_idx" ON "custom_objects" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "custom_objects_entity_key_idx" ON "custom_objects" USING btree ("entity_key");--> statement-breakpoint
CREATE INDEX "custom_objects_status_idx" ON "custom_objects" USING btree ("status","sort_order");