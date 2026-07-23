CREATE TABLE "project_pipeline_stages" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"project_id" varchar(30) NOT NULL,
	"name" varchar(255) NOT NULL,
	"color" varchar(50),
	"position" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX "project_pipeline_stages_project_id_idx" ON "project_pipeline_stages" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "project_pipeline_stages_position_idx" ON "project_pipeline_stages" USING btree ("position");