CREATE TABLE "workspace_due_index" (
	"kind" varchar(40) NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"next_due_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "workspace_due_index_kind_workspace_id_pk" PRIMARY KEY("kind","workspace_id")
);
--> statement-breakpoint
CREATE INDEX "workspace_due_index_kind_due_idx" ON "workspace_due_index" USING btree ("kind","next_due_at");