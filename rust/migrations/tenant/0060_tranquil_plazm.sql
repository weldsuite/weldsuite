CREATE TABLE "task_comments" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"task_id" varchar(255) NOT NULL,
	"task_type" varchar(20) NOT NULL,
	"content" text NOT NULL,
	"author_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE INDEX "task_comments_task_idx" ON "task_comments" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "task_comments_author_idx" ON "task_comments" USING btree ("author_id");--> statement-breakpoint
CREATE INDEX "task_comments_created_idx" ON "task_comments" USING btree ("created_at");