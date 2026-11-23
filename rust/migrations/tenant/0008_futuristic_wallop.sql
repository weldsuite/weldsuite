CREATE TABLE "analytics_reports" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"app" varchar(50) NOT NULL,
	"title" varchar(255) NOT NULL,
	"description" text,
	"created_by_id" varchar(255),
	"chart_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "analytics_charts" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"app" varchar(50) NOT NULL,
	"report_id" varchar(30) NOT NULL,
	"title" varchar(255) NOT NULL,
	"description" text,
	"chart_type" varchar(50) NOT NULL,
	"entity" varchar(50) NOT NULL,
	"metric" varchar(100) NOT NULL,
	"color" varchar(20) DEFAULT '#3b82f6' NOT NULL,
	"smooth_curve" boolean DEFAULT true NOT NULL,
	"fill_area" boolean DEFAULT true NOT NULL,
	"show_data_labels" boolean DEFAULT false NOT NULL,
	"show_legend" boolean DEFAULT true NOT NULL,
	"time_range" varchar(50) DEFAULT 'last_30_days',
	"group_by" varchar(50) DEFAULT 'day',
	"aggregation" varchar(50) DEFAULT 'sum',
	"sort_order" varchar(10) DEFAULT 'asc',
	"limit" integer,
	"compare_with" varchar(50),
	"layout" jsonb NOT NULL,
	"sort_index" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "analytics_charts" ADD CONSTRAINT "analytics_charts_report_id_analytics_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."analytics_reports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "analytics_reports_workspace_app_idx" ON "analytics_reports" USING btree ("workspace_id","app");--> statement-breakpoint
CREATE INDEX "analytics_charts_workspace_app_idx" ON "analytics_charts" USING btree ("workspace_id","app");--> statement-breakpoint
CREATE INDEX "analytics_charts_report_idx" ON "analytics_charts" USING btree ("report_id");--> statement-breakpoint
CREATE MATERIALIZED VIEW "public"."mv_crm_activities_daily" AS (select "workspace_id", DATE_TRUNC('day', "created_at") as "period", "type", "status", "related_to", "call_direction", COUNT(*) as "activity_count", COUNT(*) FILTER (WHERE "status" = 'completed') as "completed_count", AVG("duration") FILTER (WHERE "duration" IS NOT NULL) as "avg_duration", SUM("duration") FILTER (WHERE "duration" IS NOT NULL) as "total_duration", AVG("call_duration") FILTER (WHERE "call_duration" IS NOT NULL) as "avg_call_duration", SUM("call_duration") FILTER (WHERE "call_duration" IS NOT NULL) as "total_call_duration", COUNT(*) FILTER (WHERE "call_direction" = 'inbound') as "inbound_calls", COUNT(*) FILTER (WHERE "call_direction" = 'outbound') as "outbound_calls" from "crm_activities" where "crm_activities"."deleted_at" IS NULL group by "crm_activities"."workspace_id", DATE_TRUNC('day', "crm_activities"."created_at"), "crm_activities"."type", "crm_activities"."status", "crm_activities"."related_to", "crm_activities"."call_direction") WITH NO DATA;--> statement-breakpoint
CREATE MATERIALIZED VIEW "public"."mv_crm_leads_daily" AS (select "workspace_id", DATE_TRUNC('day', "created_at") as "period", "status", "source", "rating", COUNT(*) as "lead_count", COUNT(*) FILTER (WHERE "is_qualified" = true) as "qualified_count", COUNT(*) FILTER (WHERE "converted_at" IS NOT NULL) as "converted_count", AVG("score") as "avg_score", AVG(EXTRACT(EPOCH FROM ("converted_at" - "created_at")) / 3600) FILTER (WHERE "converted_at" IS NOT NULL) as "avg_time_to_convert", AVG(EXTRACT(EPOCH FROM ("qualified_at" - "created_at")) / 3600) FILTER (WHERE "qualified_at" IS NOT NULL) as "avg_time_to_qualify", AVG(EXTRACT(EPOCH FROM ("first_response_at" - "created_at")) / 3600) FILTER (WHERE "first_response_at" IS NOT NULL) as "avg_time_to_first_response" from "crm_leads" where "crm_leads"."deleted_at" IS NULL group by "crm_leads"."workspace_id", DATE_TRUNC('day', "crm_leads"."created_at"), "crm_leads"."status", "crm_leads"."source", "crm_leads"."rating") WITH NO DATA;--> statement-breakpoint
CREATE MATERIALIZED VIEW "public"."mv_crm_opportunities_daily" AS (select "workspace_id", DATE_TRUNC('day', "created_at") as "period", "stage", "status", "forecast_category", "risk_level", COUNT(*) as "opportunity_count", COUNT(*) FILTER (WHERE "status" = 'won') as "won_count", COUNT(*) FILTER (WHERE "status" = 'lost') as "lost_count", SUM("amount") as "total_amount", AVG("amount") as "avg_amount", SUM("amount" * "probability" / 100) as "weighted_amount", SUM("amount") FILTER (WHERE "status" = 'won') as "won_amount", SUM("amount") FILTER (WHERE "status" = 'lost') as "lost_amount", AVG("probability") as "avg_probability", AVG("days_in_current_stage") as "avg_days_in_stage" from "crm_opportunities" where "crm_opportunities"."deleted_at" IS NULL group by "crm_opportunities"."workspace_id", DATE_TRUNC('day', "crm_opportunities"."created_at"), "crm_opportunities"."stage", "crm_opportunities"."status", "crm_opportunities"."forecast_category", "crm_opportunities"."risk_level") WITH NO DATA;--> statement-breakpoint
CREATE MATERIALIZED VIEW "public"."mv_milestone_stats" AS (select "workspace_id", "project_id", "id", "name", "status", "due_date", "completed_at", "progress", "completed_tasks", "total_tasks", CASE WHEN "due_date" < NOW() AND "status" != 'completed' THEN true ELSE false END as "is_overdue", CASE WHEN "completed_at" IS NOT NULL AND "completed_at" <= "due_date" THEN true ELSE false END as "is_on_time", "is_key_milestone" from "milestones" where "milestones"."deleted_at" IS NULL) WITH NO DATA;--> statement-breakpoint
CREATE MATERIALIZED VIEW "public"."mv_projects_summary_daily" AS (select "workspace_id", DATE_TRUNC('day', "created_at") as "period", "id", "status", "health", COUNT(*) as "project_count", COUNT(*) FILTER (WHERE "is_active" = true) as "active_count", SUM("budgeted_hours") as "total_budgeted_hours", SUM("actual_hours") as "total_actual_hours", SUM("budgeted_amount") as "total_budgeted_amount", SUM("actual_amount") as "total_actual_amount", AVG("progress") as "avg_progress", SUM("total_tasks") as "total_tasks", SUM("completed_tasks") as "completed_tasks", SUM("total_milestones") as "total_milestones", SUM("completed_milestones") as "completed_milestones" from "projects" where "projects"."deleted_at" IS NULL group by "projects"."workspace_id", DATE_TRUNC('day', "projects"."created_at"), "projects"."id", "projects"."status", "projects"."health") WITH NO DATA;--> statement-breakpoint
CREATE MATERIALIZED VIEW "public"."mv_tasks_daily" AS (select "workspace_id", DATE_TRUNC('day', "created_at") as "period", "project_id", "status", "priority", "type", COUNT(*) as "task_count", COUNT(*) FILTER (WHERE "status" = 'done') as "completed_count", COUNT(*) FILTER (WHERE "due_date" < NOW() AND "status" != 'done' AND "status" != 'cancelled') as "overdue_count", SUM("estimated_hours") as "total_estimated_hours", SUM("actual_hours") as "total_actual_hours", AVG("progress") as "avg_progress" from "tasks" where "tasks"."deleted_at" IS NULL group by "tasks"."workspace_id", DATE_TRUNC('day', "tasks"."created_at"), "tasks"."project_id", "tasks"."status", "tasks"."priority", "tasks"."type") WITH NO DATA;--> statement-breakpoint
CREATE MATERIALIZED VIEW "public"."mv_time_entries_daily" AS (select "workspace_id", DATE_TRUNC('day', "date"::timestamp) as "period", "project_id", "user_id", "status", COUNT(*) as "entry_count", SUM("duration") as "total_duration", SUM("duration") FILTER (WHERE "billable" = true) as "billable_duration", SUM("duration") FILTER (WHERE "billable" = false) as "non_billable_duration", SUM("cost") as "total_cost", AVG("rate") FILTER (WHERE "rate" IS NOT NULL) as "avg_rate" from "time_entries" where "time_entries"."deleted_at" IS NULL group by "time_entries"."workspace_id", DATE_TRUNC('day', "time_entries"."date"::timestamp), "time_entries"."project_id", "time_entries"."user_id", "time_entries"."status") WITH NO DATA;