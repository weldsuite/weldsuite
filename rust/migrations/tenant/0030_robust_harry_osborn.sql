CREATE TABLE "grid_views" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"grid_name" varchar(100) NOT NULL,
	"column_visibility" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "grid_views_user_grid_idx" ON "grid_views" USING btree ("user_id","grid_name");