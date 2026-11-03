CREATE TABLE "project_control_links" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"project_id" varchar(255) NOT NULL,
	"from_type" varchar(30) NOT NULL,
	"from_id" varchar(255) NOT NULL,
	"to_type" varchar(30) NOT NULL,
	"to_id" varchar(255) NOT NULL,
	"relation" varchar(30) NOT NULL,
	"created_by" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_raid_assessments" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"item_id" varchar(30) NOT NULL,
	"project_id" varchar(255) NOT NULL,
	"probability" smallint NOT NULL,
	"impact" smallint NOT NULL,
	"score" integer GENERATED ALWAYS AS (probability * impact) STORED,
	"residual_probability" smallint,
	"residual_impact" smallint,
	"note" text,
	"assessed_by" varchar(255) NOT NULL,
	"assessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_raid_assessments_scale_check" CHECK ("project_raid_assessments"."probability" between 1 and 5 and "project_raid_assessments"."impact" between 1 and 5
        and ("project_raid_assessments"."residual_probability" is null or "project_raid_assessments"."residual_probability" between 1 and 5)
        and ("project_raid_assessments"."residual_impact" is null or "project_raid_assessments"."residual_impact" between 1 and 5))
);
--> statement-breakpoint
CREATE TABLE "project_raid_items" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"project_id" varchar(255) NOT NULL,
	"kind" varchar(20) NOT NULL,
	"number" integer NOT NULL,
	"title" varchar(255) NOT NULL,
	"description" text,
	"status" varchar(30) NOT NULL,
	"category" varchar(100),
	"owner_id" varchar(255),
	"due_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"custom_fields" jsonb,
	"probability" smallint,
	"impact" smallint,
	"score" integer GENERATED ALWAYS AS (probability * impact) STORED,
	"residual_probability" smallint,
	"residual_impact" smallint,
	"strategy" varchar(20),
	"trigger" text,
	"cost_impact" numeric(18, 2),
	"schedule_impact_days" integer,
	"review_interval_days" integer,
	"confidence" varchar(10),
	"if_wrong" text,
	"severity" varchar(20),
	"escalated_at" timestamp with time zone,
	"direction" varchar(10),
	"party_type" varchar(20),
	"party_project_id" varchar(255),
	"party_name" varchar(255),
	"created_by" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "project_raid_items_kind_check" CHECK ("project_raid_items"."kind" in ('risk', 'assumption', 'issue', 'dependency')),
	CONSTRAINT "project_raid_items_status_check" CHECK (("project_raid_items"."kind" = 'risk' and "project_raid_items"."status" in ('identified', 'assessing', 'mitigating', 'monitoring', 'occurred', 'closed'))
        or ("project_raid_items"."kind" = 'assumption' and "project_raid_items"."status" in ('open', 'validated', 'invalid'))
        or ("project_raid_items"."kind" = 'issue' and "project_raid_items"."status" in ('open', 'in_progress', 'resolved', 'closed'))
        or ("project_raid_items"."kind" = 'dependency' and "project_raid_items"."status" in ('open', 'at_risk', 'delivered', 'closed'))),
	CONSTRAINT "project_raid_items_risk_required_check" CHECK ("project_raid_items"."kind" <> 'risk' or ("project_raid_items"."probability" is not null and "project_raid_items"."impact" is not null)),
	CONSTRAINT "project_raid_items_scale_check" CHECK (("project_raid_items"."probability" is null or "project_raid_items"."probability" between 1 and 5)
        and ("project_raid_items"."impact" is null or "project_raid_items"."impact" between 1 and 5)
        and ("project_raid_items"."residual_probability" is null or "project_raid_items"."residual_probability" between 1 and 5)
        and ("project_raid_items"."residual_impact" is null or "project_raid_items"."residual_impact" between 1 and 5)),
	CONSTRAINT "project_raid_items_residual_pair_check" CHECK (("project_raid_items"."residual_probability" is null) = ("project_raid_items"."residual_impact" is null)),
	CONSTRAINT "project_raid_items_risk_columns_check" CHECK ("project_raid_items"."kind" = 'risk' or ("project_raid_items"."probability" is null and "project_raid_items"."impact" is null
        and "project_raid_items"."residual_probability" is null and "project_raid_items"."residual_impact" is null
        and "project_raid_items"."strategy" is null and "project_raid_items"."trigger" is null and "project_raid_items"."cost_impact" is null
        and "project_raid_items"."schedule_impact_days" is null and "project_raid_items"."review_interval_days" is null)),
	CONSTRAINT "project_raid_items_assumption_columns_check" CHECK ("project_raid_items"."kind" = 'assumption' or ("project_raid_items"."confidence" is null and "project_raid_items"."if_wrong" is null)),
	CONSTRAINT "project_raid_items_issue_columns_check" CHECK ("project_raid_items"."kind" = 'issue' or ("project_raid_items"."severity" is null and "project_raid_items"."escalated_at" is null)),
	CONSTRAINT "project_raid_items_dependency_columns_check" CHECK ("project_raid_items"."kind" = 'dependency' or ("project_raid_items"."direction" is null and "project_raid_items"."party_type" is null
        and "project_raid_items"."party_project_id" is null and "project_raid_items"."party_name" is null))
);
--> statement-breakpoint
ALTER TABLE "task_number_sequences" ALTER COLUMN "scope" SET DATA TYPE varchar(300);--> statement-breakpoint
ALTER TABLE "project_control_links" ADD CONSTRAINT "project_control_links_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_raid_assessments" ADD CONSTRAINT "project_raid_assessments_item_id_project_raid_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."project_raid_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_raid_assessments" ADD CONSTRAINT "project_raid_assessments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_raid_items" ADD CONSTRAINT "project_raid_items_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_raid_items" ADD CONSTRAINT "project_raid_items_party_project_id_projects_id_fk" FOREIGN KEY ("party_project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_control_links_pair_idx" ON "project_control_links" USING btree ("from_type","from_id","to_type","to_id");--> statement-breakpoint
CREATE INDEX "project_control_links_to_idx" ON "project_control_links" USING btree ("to_type","to_id");--> statement-breakpoint
CREATE INDEX "project_control_links_project_idx" ON "project_control_links" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "project_raid_assessments_item_idx" ON "project_raid_assessments" USING btree ("item_id","assessed_at");--> statement-breakpoint
CREATE INDEX "project_raid_assessments_project_idx" ON "project_raid_assessments" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "project_raid_items_project_kind_idx" ON "project_raid_items" USING btree ("project_id","kind");--> statement-breakpoint
CREATE INDEX "project_raid_items_project_due_idx" ON "project_raid_items" USING btree ("project_id","due_at");--> statement-breakpoint
CREATE UNIQUE INDEX "project_raid_items_project_kind_number_idx" ON "project_raid_items" USING btree ("project_id","kind","number");