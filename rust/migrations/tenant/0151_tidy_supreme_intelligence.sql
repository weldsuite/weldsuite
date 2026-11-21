CREATE TABLE "document_versions" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"file_id" varchar(255) NOT NULL,
	"content" jsonb NOT NULL,
	"label" varchar(255),
	"created_by_id" varchar(255)
);
--> statement-breakpoint
CREATE TABLE "whiteboards" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"file_id" varchar(255) NOT NULL,
	"scene" jsonb NOT NULL,
	"updated_by_id" varchar(255)
);
--> statement-breakpoint
CREATE TABLE "warehouse_workers" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"user_id" varchar(30),
	"name" varchar(255) NOT NULL,
	"email" varchar(255),
	"phone" varchar(50),
	"warehouse_id" varchar(30),
	"role" varchar(50) DEFAULT 'picker',
	"status" varchar(20) DEFAULT 'active',
	"skills" jsonb,
	"notes" text,
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "activity_logs" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"activity_type" varchar(50) NOT NULL,
	"entity_type" varchar(50),
	"entity_id" varchar(30),
	"user_id" varchar(30),
	"warehouse_id" varchar(30),
	"description" text,
	"metadata" jsonb
);
--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whiteboards" ADD CONSTRAINT "whiteboards_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_versions_file_idx" ON "document_versions" USING btree ("file_id","created_at");--> statement-breakpoint
CREATE INDEX "whiteboards_file_idx" ON "whiteboards" USING btree ("file_id");--> statement-breakpoint
CREATE INDEX "warehouse_workers_warehouse_idx" ON "warehouse_workers" USING btree ("warehouse_id");--> statement-breakpoint
CREATE INDEX "warehouse_workers_status_idx" ON "warehouse_workers" USING btree ("status");--> statement-breakpoint
CREATE INDEX "activity_logs_entity_idx" ON "activity_logs" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "activity_logs_user_idx" ON "activity_logs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "activity_logs_warehouse_idx" ON "activity_logs" USING btree ("warehouse_id");--> statement-breakpoint
CREATE INDEX "activity_logs_created_idx" ON "activity_logs" USING btree ("created_at");