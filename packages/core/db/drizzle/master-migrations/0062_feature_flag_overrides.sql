CREATE TABLE "feature_flag_overrides" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"flag_key" varchar(100) NOT NULL,
	"workspace_id" varchar(255),
	"value" jsonb NOT NULL,
	"updated_by" varchar(255),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feature_flag_overrides_flag_workspace_unique" UNIQUE NULLS NOT DISTINCT("flag_key","workspace_id")
);
