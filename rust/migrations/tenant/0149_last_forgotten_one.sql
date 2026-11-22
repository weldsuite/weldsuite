CREATE TABLE "docs" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"file_id" varchar(255) NOT NULL,
	"content" jsonb NOT NULL,
	"updated_by_id" varchar(255)
);
--> statement-breakpoint
ALTER TABLE "docs" ADD CONSTRAINT "docs_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "docs_file_idx" ON "docs" USING btree ("file_id");