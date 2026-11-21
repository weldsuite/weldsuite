CREATE TABLE "project_baselines" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"project_id" varchar(255) NOT NULL,
	"version" integer NOT NULL,
	"change_request_id" varchar(30),
	"snapshot" jsonb NOT NULL,
	"created_by" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_benefit_measurements" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"benefit_id" varchar(30) NOT NULL,
	"project_id" varchar(255) NOT NULL,
	"period" varchar(7) NOT NULL,
	"value" numeric(18, 4) NOT NULL,
	"measured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"measured_by" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_benefit_measurements_period_check" CHECK ("project_benefit_measurements"."period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')
);
--> statement-breakpoint
CREATE TABLE "project_benefits" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"project_id" varchar(255) NOT NULL,
	"number" integer NOT NULL,
	"title" varchar(255) NOT NULL,
	"description" text,
	"owner_id" varchar(255),
	"goal_ref" varchar(255),
	"metric" varchar(60) DEFAULT 'manual' NOT NULL,
	"metric_params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"unit" varchar(30),
	"baseline_value" numeric(18, 4),
	"target_value" numeric(18, 4),
	"realise_by" timestamp with time zone,
	"status" varchar(20) DEFAULT 'planned' NOT NULL,
	"closed_at" timestamp with time zone,
	"created_by" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "project_benefits_status_check" CHECK ("project_benefits"."status" in ('planned', 'measuring', 'at_risk', 'realised', 'closed'))
);
--> statement-breakpoint
CREATE TABLE "project_change_requests" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"project_id" varchar(255) NOT NULL,
	"number" integer NOT NULL,
	"title" varchar(255) NOT NULL,
	"description" text,
	"requested_by" varchar(255),
	"requested_by_name" varchar(255),
	"status" varchar(30) DEFAULT 'draft' NOT NULL,
	"cost_delta" numeric(18, 2),
	"schedule_delta_days" integer,
	"plan_changes" jsonb,
	"scope_changes" jsonb,
	"route" varchar(20),
	"submitted_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"baseline_id" varchar(30),
	"client_visible" boolean DEFAULT false NOT NULL,
	"created_by" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "project_change_requests_status_check" CHECK ("project_change_requests"."status" in ('draft', 'assessing', 'awaiting_approval', 'approved', 'rejected', 'implemented', 'withdrawn')),
	CONSTRAINT "project_change_requests_route_check" CHECK ("project_change_requests"."route" is null or "project_change_requests"."route" in ('manager', 'board'))
);
--> statement-breakpoint
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
CREATE TABLE "project_decisions" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"project_id" varchar(255) NOT NULL,
	"number" integer NOT NULL,
	"title" varchar(255) NOT NULL,
	"status" varchar(20) DEFAULT 'proposed' NOT NULL,
	"context" text,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"consequences" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"decider_id" varchar(255),
	"decided_by" varchar(255),
	"decided_at" timestamp with time zone,
	"decision_due_at" timestamp with time zone,
	"superseded_by_id" varchar(30),
	"created_by" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "project_decisions_status_check" CHECK ("project_decisions"."status" in ('proposed', 'decided', 'superseded'))
);
--> statement-breakpoint
CREATE TABLE "project_deliverables" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"project_id" varchar(255) NOT NULL,
	"number" integer NOT NULL,
	"title" varchar(255) NOT NULL,
	"description" text,
	"owner_id" varchar(255),
	"status" varchar(20) DEFAULT 'not_started' NOT NULL,
	"planned_start" timestamp with time zone,
	"planned_end" timestamp with time zone,
	"acceptance_criteria" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"accepted_by" varchar(255),
	"accepted_at" timestamp with time zone,
	"position" integer DEFAULT 0 NOT NULL,
	"client_visible" boolean DEFAULT false NOT NULL,
	"created_by" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "project_deliverables_status_check" CHECK ("project_deliverables"."status" in ('not_started', 'in_progress', 'accepted', 'rejected'))
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
CREATE TABLE "project_scope" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"project_id" varchar(255) NOT NULL,
	"statement" text,
	"in_scope" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"out_of_scope" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" varchar(255) NOT NULL,
	"updated_by" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "flow_approval_delegations" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"member_id" varchar(255) NOT NULL,
	"delegate_id" varchar(255) NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"created_by" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "flow_approval_delegations_period_check" CHECK ("flow_approval_delegations"."ends_at" > "flow_approval_delegations"."starts_at"),
	CONSTRAINT "flow_approval_delegations_self_check" CHECK ("flow_approval_delegations"."member_id" <> "flow_approval_delegations"."delegate_id")
);
--> statement-breakpoint
CREATE TABLE "flow_approvals" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"project_id" varchar(255),
	"subject_type" varchar(30) NOT NULL,
	"subject_id" varchar(255) NOT NULL,
	"approver_kind" varchar(10) DEFAULT 'member' NOT NULL,
	"approver_id" varchar(255) NOT NULL,
	"role_label" varchar(100),
	"step" integer DEFAULT 1 NOT NULL,
	"rule" jsonb NOT NULL,
	"decision" varchar(30) DEFAULT 'pending' NOT NULL,
	"note" text,
	"due_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"decided_by" varchar(255),
	"delegated_from" varchar(255),
	"reminded_at" timestamp with time zone,
	"overdue_notified_at" timestamp with time zone,
	"created_by" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "flow_approvals_subject_type_check" CHECK ("flow_approvals"."subject_type" in ('change_request', 'gate', 'deliverable', 'decision', 'risk_acceptance', 'project_request', 'project_close')),
	CONSTRAINT "flow_approvals_approver_kind_check" CHECK ("flow_approvals"."approver_kind" in ('member', 'contact')),
	CONSTRAINT "flow_approvals_decision_check" CHECK ("flow_approvals"."decision" in ('pending', 'approved', 'approved_with_conditions', 'rejected', 'info_requested')),
	CONSTRAINT "flow_approvals_step_check" CHECK ("flow_approvals"."step" >= 1)
);
--> statement-breakpoint
CREATE TABLE "flow_member_profiles" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"member_id" varchar(255) NOT NULL,
	"weekly_hours" numeric(5, 2) DEFAULT '40' NOT NULL,
	"skills" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "flow_member_profiles_hours_check" CHECK ("flow_member_profiles"."weekly_hours" between 0 and 168)
);
--> statement-breakpoint
CREATE TABLE "flow_workspace_settings" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"singleton" boolean DEFAULT true NOT NULL,
	"scoring_model" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"portfolio_board_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"expense_approval_limit" numeric(18, 2),
	"updated_by" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "flow_workspace_settings_singleton_check" CHECK ("flow_workspace_settings"."singleton")
);
--> statement-breakpoint
CREATE TABLE "project_finance_snapshots" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"project_id" varchar(255) NOT NULL,
	"week" varchar(8) NOT NULL,
	"budget" numeric(18, 2),
	"planned_value" numeric(18, 2) DEFAULT '0' NOT NULL,
	"earned_value" numeric(18, 2) DEFAULT '0' NOT NULL,
	"actual_cost" numeric(18, 2) DEFAULT '0' NOT NULL,
	"committed" numeric(18, 2) DEFAULT '0' NOT NULL,
	"forecast" numeric(18, 2),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_finance_snapshots_week_check" CHECK ("project_finance_snapshots"."week" ~ '^[0-9]{4}-W(0[1-9]|[1-4][0-9]|5[0-3])$')
);
--> statement-breakpoint
CREATE TABLE "project_lessons" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"project_id" varchar(255) NOT NULL,
	"category" varchar(20) NOT NULL,
	"text" text NOT NULL,
	"author_id" varchar(255) NOT NULL,
	"votes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"know_page_id" varchar(30),
	"created_by" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "project_lessons_category_check" CHECK ("project_lessons"."category" in ('went_well', 'went_badly', 'do_differently'))
);
--> statement-breakpoint
CREATE TABLE "project_phases" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"project_id" varchar(255) NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"name" varchar(255) NOT NULL,
	"planned_start" timestamp with time zone,
	"planned_end" timestamp with time zone,
	"status" varchar(20) DEFAULT 'upcoming' NOT NULL,
	"gate_criteria" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"gate_result" jsonb,
	"gate_requested_at" timestamp with time zone,
	"passed_at" timestamp with time zone,
	"created_by" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "project_phases_status_check" CHECK ("project_phases"."status" in ('upcoming', 'active', 'passed'))
);
--> statement-breakpoint
CREATE TABLE "project_raci" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"project_id" varchar(255) NOT NULL,
	"subject_type" varchar(20) NOT NULL,
	"subject_id" varchar(255),
	"stakeholder_id" varchar(30) NOT NULL,
	"letter" varchar(1) NOT NULL,
	"created_by" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_raci_subject_type_check" CHECK ("project_raci"."subject_type" in ('deliverable', 'change_requests', 'go_live')),
	CONSTRAINT "project_raci_letter_check" CHECK ("project_raci"."letter" in ('R', 'A', 'C', 'I')),
	CONSTRAINT "project_raci_subject_check" CHECK (("project_raci"."subject_type" = 'deliverable') = ("project_raci"."subject_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "project_requests" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"number" integer NOT NULL,
	"title" varchar(255) NOT NULL,
	"requested_by" varchar(255) NOT NULL,
	"business_case" text,
	"estimated_cost" numeric(18, 2),
	"estimated_value" numeric(18, 2),
	"scores" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"score" numeric(8, 2),
	"needed_skills" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"desired_start" date,
	"desired_end" date,
	"status" varchar(20) DEFAULT 'new' NOT NULL,
	"submitted_at" timestamp with time zone,
	"project_id" varchar(255),
	"created_by" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "project_requests_status_check" CHECK ("project_requests"."status" in ('new', 'assessing', 'approved', 'rejected', 'converted'))
);
--> statement-breakpoint
CREATE TABLE "project_stakeholders" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"project_id" varchar(255) NOT NULL,
	"member_id" varchar(255),
	"crm_contact_id" varchar(30),
	"organisation" varchar(255),
	"role" varchar(100),
	"influence" smallint DEFAULT 3 NOT NULL,
	"interest" smallint DEFAULT 3 NOT NULL,
	"attitude" varchar(20) DEFAULT 'neutral' NOT NULL,
	"engagement" varchar(20) DEFAULT 'neutral' NOT NULL,
	"notes" text,
	"last_contact_at" timestamp with time zone,
	"portal_access" boolean DEFAULT false NOT NULL,
	"portal_invited_at" timestamp with time zone,
	"created_by" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "project_stakeholders_identity_check" CHECK (("project_stakeholders"."member_id" is null) <> ("project_stakeholders"."crm_contact_id" is null)),
	CONSTRAINT "project_stakeholders_scale_check" CHECK ("project_stakeholders"."influence" between 1 and 5 and "project_stakeholders"."interest" between 1 and 5),
	CONSTRAINT "project_stakeholders_attitude_check" CHECK ("project_stakeholders"."attitude" in ('supportive', 'neutral', 'resistant')),
	CONSTRAINT "project_stakeholders_engagement_check" CHECK ("project_stakeholders"."engagement" in ('unaware', 'resistant', 'neutral', 'supportive', 'leading'))
);
--> statement-breakpoint
CREATE TABLE "project_status_reports" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"project_id" varchar(255) NOT NULL,
	"period" varchar(10) NOT NULL,
	"status" varchar(20) DEFAULT 'draft' NOT NULL,
	"overall" varchar(10),
	"areas" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"summary" text,
	"done" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"next" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"snapshot" jsonb,
	"client_visible" boolean DEFAULT false NOT NULL,
	"supersedes_id" varchar(30),
	"published_by" varchar(255),
	"published_at" timestamp with time zone,
	"recipients" jsonb,
	"created_by" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "project_status_reports_status_check" CHECK ("project_status_reports"."status" in ('draft', 'published')),
	CONSTRAINT "project_status_reports_period_check" CHECK ("project_status_reports"."period" ~ '^[0-9]{4}-(W(0[1-9]|[1-4][0-9]|5[0-3])|(0[1-9]|1[0-2]))$')
);
--> statement-breakpoint
CREATE TABLE "project_templates" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"blueprint" jsonb NOT NULL,
	"source_project_id" varchar(255),
	"shared" boolean DEFAULT false NOT NULL,
	"created_by" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "resource_bookings" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"member_id" varchar(255) NOT NULL,
	"project_id" varchar(255),
	"request_id" varchar(30),
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"hours_per_week" numeric(5, 2) NOT NULL,
	"tentative" boolean DEFAULT false NOT NULL,
	"created_by" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "resource_bookings_period_check" CHECK ("resource_bookings"."ends_on" >= "resource_bookings"."starts_on"),
	CONSTRAINT "resource_bookings_hours_check" CHECK ("resource_bookings"."hours_per_week" > 0 and "resource_bookings"."hours_per_week" <= 168),
	CONSTRAINT "resource_bookings_target_check" CHECK (("resource_bookings"."project_id" is null) <> ("resource_bookings"."request_id" is null))
);
--> statement-breakpoint
CREATE TABLE "resource_requests" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"project_id" varchar(255) NOT NULL,
	"skill" varchar(100) NOT NULL,
	"hours_per_week" numeric(5, 2) NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"status" varchar(20) DEFAULT 'open' NOT NULL,
	"booking_id" varchar(30),
	"created_by" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "resource_requests_status_check" CHECK ("resource_requests"."status" in ('open', 'booked', 'cancelled')),
	CONSTRAINT "resource_requests_period_check" CHECK ("resource_requests"."ends_on" >= "resource_requests"."starts_on"),
	CONSTRAINT "resource_requests_hours_check" CHECK ("resource_requests"."hours_per_week" > 0 and "resource_requests"."hours_per_week" <= 168)
);
--> statement-breakpoint
CREATE TABLE "task_dependencies" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"project_id" varchar(255) NOT NULL,
	"predecessor_id" varchar(255) NOT NULL,
	"successor_id" varchar(255) NOT NULL,
	"type" varchar(2) DEFAULT 'fs' NOT NULL,
	"lag_days" integer DEFAULT 0 NOT NULL,
	"created_by" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_dependencies_type_check" CHECK ("task_dependencies"."type" in ('fs', 'ss', 'ff', 'sf')),
	CONSTRAINT "task_dependencies_self_check" CHECK ("task_dependencies"."predecessor_id" <> "task_dependencies"."successor_id")
);
--> statement-breakpoint
ALTER TABLE "task_number_sequences" ALTER COLUMN "scope" SET DATA TYPE varchar(300);--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "deliverable_id" varchar(30);--> statement-breakpoint
ALTER TABLE "project_files" ADD COLUMN "client_visible" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "project_messages" ADD COLUMN "client_visible" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "project_documents" ADD COLUMN "client_visible" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "client_visible" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "purchase_order_items" ADD COLUMN "project_id" varchar(255);--> statement-breakpoint
ALTER TABLE "bill_items" ADD COLUMN "project_id" varchar(255);--> statement-breakpoint
ALTER TABLE "journal_lines" ADD COLUMN "project_id" varchar(255);--> statement-breakpoint
ALTER TABLE "hr_declarations" ADD COLUMN "project_id" varchar(255);--> statement-breakpoint
ALTER TABLE "project_baselines" ADD CONSTRAINT "project_baselines_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_baselines" ADD CONSTRAINT "project_baselines_change_request_id_project_change_requests_id_fk" FOREIGN KEY ("change_request_id") REFERENCES "public"."project_change_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_benefit_measurements" ADD CONSTRAINT "project_benefit_measurements_benefit_id_project_benefits_id_fk" FOREIGN KEY ("benefit_id") REFERENCES "public"."project_benefits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_benefit_measurements" ADD CONSTRAINT "project_benefit_measurements_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_benefits" ADD CONSTRAINT "project_benefits_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_change_requests" ADD CONSTRAINT "project_change_requests_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_control_links" ADD CONSTRAINT "project_control_links_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_decisions" ADD CONSTRAINT "project_decisions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_decisions" ADD CONSTRAINT "project_decisions_superseded_by_id_project_decisions_id_fk" FOREIGN KEY ("superseded_by_id") REFERENCES "public"."project_decisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_deliverables" ADD CONSTRAINT "project_deliverables_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_raid_assessments" ADD CONSTRAINT "project_raid_assessments_item_id_project_raid_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."project_raid_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_raid_assessments" ADD CONSTRAINT "project_raid_assessments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_raid_items" ADD CONSTRAINT "project_raid_items_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_raid_items" ADD CONSTRAINT "project_raid_items_party_project_id_projects_id_fk" FOREIGN KEY ("party_project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_scope" ADD CONSTRAINT "project_scope_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_approvals" ADD CONSTRAINT "flow_approvals_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_finance_snapshots" ADD CONSTRAINT "project_finance_snapshots_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_lessons" ADD CONSTRAINT "project_lessons_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_phases" ADD CONSTRAINT "project_phases_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_raci" ADD CONSTRAINT "project_raci_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_raci" ADD CONSTRAINT "project_raci_stakeholder_id_project_stakeholders_id_fk" FOREIGN KEY ("stakeholder_id") REFERENCES "public"."project_stakeholders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_requests" ADD CONSTRAINT "project_requests_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_stakeholders" ADD CONSTRAINT "project_stakeholders_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_status_reports" ADD CONSTRAINT "project_status_reports_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_templates" ADD CONSTRAINT "project_templates_source_project_id_projects_id_fk" FOREIGN KEY ("source_project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_bookings" ADD CONSTRAINT "resource_bookings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_bookings" ADD CONSTRAINT "resource_bookings_request_id_project_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."project_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_requests" ADD CONSTRAINT "resource_requests_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_requests" ADD CONSTRAINT "resource_requests_booking_id_resource_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."resource_bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_predecessor_id_tasks_id_fk" FOREIGN KEY ("predecessor_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_successor_id_tasks_id_fk" FOREIGN KEY ("successor_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_baselines_project_version_idx" ON "project_baselines" USING btree ("project_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "project_benefit_measurements_benefit_period_idx" ON "project_benefit_measurements" USING btree ("benefit_id","period");--> statement-breakpoint
CREATE INDEX "project_benefit_measurements_project_idx" ON "project_benefit_measurements" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_benefits_project_number_idx" ON "project_benefits" USING btree ("project_id","number");--> statement-breakpoint
CREATE INDEX "project_benefits_project_status_idx" ON "project_benefits" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "project_benefits_status_idx" ON "project_benefits" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "project_change_requests_project_number_idx" ON "project_change_requests" USING btree ("project_id","number");--> statement-breakpoint
CREATE INDEX "project_change_requests_project_status_idx" ON "project_change_requests" USING btree ("project_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "project_control_links_pair_idx" ON "project_control_links" USING btree ("from_type","from_id","to_type","to_id");--> statement-breakpoint
CREATE INDEX "project_control_links_to_idx" ON "project_control_links" USING btree ("to_type","to_id");--> statement-breakpoint
CREATE INDEX "project_control_links_project_idx" ON "project_control_links" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_decisions_project_number_idx" ON "project_decisions" USING btree ("project_id","number");--> statement-breakpoint
CREATE INDEX "project_decisions_project_status_idx" ON "project_decisions" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "project_decisions_project_due_idx" ON "project_decisions" USING btree ("project_id","decision_due_at");--> statement-breakpoint
CREATE UNIQUE INDEX "project_deliverables_project_number_idx" ON "project_deliverables" USING btree ("project_id","number");--> statement-breakpoint
CREATE INDEX "project_deliverables_project_status_idx" ON "project_deliverables" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "project_raid_assessments_item_idx" ON "project_raid_assessments" USING btree ("item_id","assessed_at");--> statement-breakpoint
CREATE INDEX "project_raid_assessments_project_idx" ON "project_raid_assessments" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "project_raid_items_project_kind_idx" ON "project_raid_items" USING btree ("project_id","kind");--> statement-breakpoint
CREATE INDEX "project_raid_items_project_due_idx" ON "project_raid_items" USING btree ("project_id","due_at");--> statement-breakpoint
CREATE UNIQUE INDEX "project_raid_items_project_kind_number_idx" ON "project_raid_items" USING btree ("project_id","kind","number");--> statement-breakpoint
CREATE UNIQUE INDEX "project_scope_project_idx" ON "project_scope" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "flow_approval_delegations_member_idx" ON "flow_approval_delegations" USING btree ("member_id","starts_at","ends_at");--> statement-breakpoint
CREATE INDEX "flow_approval_delegations_delegate_idx" ON "flow_approval_delegations" USING btree ("delegate_id","starts_at","ends_at");--> statement-breakpoint
CREATE INDEX "flow_approvals_approver_decision_due_idx" ON "flow_approvals" USING btree ("approver_id","decision","due_at");--> statement-breakpoint
CREATE INDEX "flow_approvals_subject_idx" ON "flow_approvals" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "flow_approvals_project_decision_idx" ON "flow_approvals" USING btree ("project_id","decision");--> statement-breakpoint
CREATE INDEX "flow_approvals_decision_due_idx" ON "flow_approvals" USING btree ("decision","due_at");--> statement-breakpoint
CREATE UNIQUE INDEX "flow_member_profiles_member_idx" ON "flow_member_profiles" USING btree ("member_id");--> statement-breakpoint
CREATE UNIQUE INDEX "flow_workspace_settings_singleton_idx" ON "flow_workspace_settings" USING btree ("singleton");--> statement-breakpoint
CREATE UNIQUE INDEX "project_finance_snapshots_project_week_idx" ON "project_finance_snapshots" USING btree ("project_id","week");--> statement-breakpoint
CREATE INDEX "project_lessons_project_category_idx" ON "project_lessons" USING btree ("project_id","category");--> statement-breakpoint
CREATE INDEX "project_phases_project_position_idx" ON "project_phases" USING btree ("project_id","position");--> statement-breakpoint
CREATE INDEX "project_raci_project_subject_idx" ON "project_raci" USING btree ("project_id","subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "project_raci_stakeholder_idx" ON "project_raci" USING btree ("stakeholder_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_raci_cell_idx" ON "project_raci" USING btree ("project_id","subject_type",coalesce("subject_id", ''),"stakeholder_id","letter");--> statement-breakpoint
CREATE UNIQUE INDEX "project_raci_one_accountable_idx" ON "project_raci" USING btree ("project_id","subject_type",coalesce("subject_id", '')) WHERE "project_raci"."letter" = 'A';--> statement-breakpoint
CREATE UNIQUE INDEX "project_requests_number_idx" ON "project_requests" USING btree ("number");--> statement-breakpoint
CREATE INDEX "project_requests_status_score_idx" ON "project_requests" USING btree ("status","score");--> statement-breakpoint
CREATE INDEX "project_stakeholders_project_idx" ON "project_stakeholders" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "project_stakeholders_contact_idx" ON "project_stakeholders" USING btree ("crm_contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_stakeholders_member_idx" ON "project_stakeholders" USING btree ("project_id","member_id") WHERE "project_stakeholders"."deleted_at" is null and "project_stakeholders"."member_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "project_stakeholders_contact_unique_idx" ON "project_stakeholders" USING btree ("project_id","crm_contact_id") WHERE "project_stakeholders"."deleted_at" is null and "project_stakeholders"."crm_contact_id" is not null;--> statement-breakpoint
CREATE INDEX "project_status_reports_project_period_idx" ON "project_status_reports" USING btree ("project_id","period");--> statement-breakpoint
CREATE INDEX "project_status_reports_project_published_idx" ON "project_status_reports" USING btree ("project_id","status","published_at");--> statement-breakpoint
CREATE INDEX "project_templates_shared_idx" ON "project_templates" USING btree ("shared");--> statement-breakpoint
CREATE INDEX "resource_bookings_member_period_idx" ON "resource_bookings" USING btree ("member_id","starts_on","ends_on");--> statement-breakpoint
CREATE INDEX "resource_bookings_project_idx" ON "resource_bookings" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "resource_bookings_request_idx" ON "resource_bookings" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "resource_requests_project_idx" ON "resource_requests" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "resource_requests_status_idx" ON "resource_requests" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "task_dependencies_pair_idx" ON "task_dependencies" USING btree ("predecessor_id","successor_id");--> statement-breakpoint
CREATE INDEX "task_dependencies_successor_idx" ON "task_dependencies" USING btree ("successor_id");--> statement-breakpoint
CREATE INDEX "task_dependencies_project_idx" ON "task_dependencies" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "tasks_deliverable_idx" ON "tasks" USING btree ("deliverable_id");--> statement-breakpoint
CREATE INDEX "po_items_project_idx" ON "purchase_order_items" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "acct_bill_items_project_idx" ON "bill_items" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "acct_journal_lines_project_idx" ON "journal_lines" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "hr_declarations_project_idx" ON "hr_declarations" USING btree ("project_id");