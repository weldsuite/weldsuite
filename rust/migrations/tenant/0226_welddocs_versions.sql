CREATE TABLE "doc_versions" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"doc_id" varchar(255) NOT NULL,
	"revision" integer NOT NULL,
	"name" varchar(255),
	"snapshot_key" varchar(1000) NOT NULL,
	"size" integer DEFAULT 0 NOT NULL,
	"created_by_id" varchar(255)
);
--> statement-breakpoint
ALTER TABLE "doc_versions" ADD CONSTRAINT "doc_versions_doc_id_docs_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."docs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "doc_versions_doc_idx" ON "doc_versions" USING btree ("doc_id","created_at");