CREATE TABLE "knowledge_spaces" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"name" varchar(255) NOT NULL,
	"description" text,
	"icon" varchar(100),
	"color" varchar(50),
	"visibility" varchar(20) DEFAULT 'workspace' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_by" varchar(255)
);
--> statement-breakpoint
CREATE TABLE "knowledge_pages" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"space_id" varchar(255) NOT NULL,
	"parent_id" varchar(255),
	"position" integer DEFAULT 0 NOT NULL,
	"title" varchar(500) DEFAULT 'Untitled' NOT NULL,
	"content_json" jsonb,
	"content_text" text,
	"icon" varchar(100),
	"cover_image" varchar(1000),
	"is_locked" boolean DEFAULT false NOT NULL,
	"created_by" varchar(255),
	"last_edited_by" varchar(255)
);
--> statement-breakpoint
CREATE TABLE "knowledge_page_versions" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"page_id" varchar(255) NOT NULL,
	"content" jsonb NOT NULL,
	"label" varchar(255),
	"created_by_id" varchar(255)
);
--> statement-breakpoint
CREATE TABLE "knowledge_favorites" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"page_id" varchar(255) NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"position" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "knowledge_pages" ADD CONSTRAINT "knowledge_pages_space_id_knowledge_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."knowledge_spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_page_versions" ADD CONSTRAINT "knowledge_page_versions_page_id_knowledge_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."knowledge_pages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_favorites" ADD CONSTRAINT "knowledge_favorites_page_id_knowledge_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."knowledge_pages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "knowledge_spaces_sort_order_idx" ON "knowledge_spaces" USING btree ("sort_order");--> statement-breakpoint
CREATE INDEX "knowledge_pages_space_idx" ON "knowledge_pages" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "knowledge_pages_parent_idx" ON "knowledge_pages" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "knowledge_pages_parent_position_idx" ON "knowledge_pages" USING btree ("parent_id","position");--> statement-breakpoint
CREATE INDEX "knowledge_pages_deleted_idx" ON "knowledge_pages" USING btree ("deleted_at");--> statement-breakpoint
CREATE INDEX "knowledge_page_versions_page_idx" ON "knowledge_page_versions" USING btree ("page_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_favorites_page_user_idx" ON "knowledge_favorites" USING btree ("page_id","user_id");--> statement-breakpoint
CREATE INDEX "knowledge_favorites_user_idx" ON "knowledge_favorites" USING btree ("user_id");