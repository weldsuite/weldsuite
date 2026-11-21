CREATE TABLE "desk_conversations" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"conversation_number" integer NOT NULL,
	"title" varchar(500),
	"state" varchar(10) DEFAULT 'open' NOT NULL,
	"read" boolean DEFAULT false NOT NULL,
	"priority" boolean DEFAULT false NOT NULL,
	"waiting_since" timestamp,
	"snoozed_until" timestamp,
	"admin_assignee_id" varchar(255),
	"team_assignee_id" varchar(30),
	"contact_id" varchar(30),
	"counterparty_id" varchar(30),
	"person_id" varchar(30),
	"channel" varchar(20) NOT NULL,
	"source" jsonb NOT NULL,
	"custom_attributes" jsonb,
	"tags" jsonb,
	"conversation_rating" jsonb,
	"statistics" jsonb,
	"ai_agent_participated" boolean DEFAULT false NOT NULL,
	"ai_agent" jsonb,
	"ticket_type_id" varchar(30),
	"ticket_state_id" varchar(30),
	"ticket_category" varchar(15),
	"ticket_number" integer,
	"ticket_attributes" jsonb,
	"is_shared" boolean
);
--> statement-breakpoint
CREATE TABLE "desk_conversation_parts" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"conversation_id" varchar(30) NOT NULL,
	"part_type" varchar(40) NOT NULL,
	"body" text,
	"blocks" jsonb,
	"block_responses" jsonb,
	"author_type" varchar(10) NOT NULL,
	"author_id" varchar(255),
	"from_ai_agent" boolean DEFAULT false NOT NULL,
	"is_ai_answer" boolean DEFAULT false NOT NULL,
	"assigned_to_type" varchar(10),
	"assigned_to_id" varchar(255),
	"attachments" jsonb,
	"email_message_id" varchar(998),
	"email_metadata" jsonb,
	"attribute_change" jsonb,
	"state_snapshot" varchar(10) NOT NULL,
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "desk_conversation_attributes" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"data_type" varchar(10) NOT NULL,
	"list_options" jsonb,
	"reference_type" varchar(50),
	"required_before_close" boolean DEFAULT false NOT NULL,
	"conditional_parent_id" varchar(30),
	"conditional_parent_value" jsonb,
	"order" integer DEFAULT 0 NOT NULL,
	"archived" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "desk_linked_objects" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"source_id" varchar(30) NOT NULL,
	"target_id" varchar(30) NOT NULL,
	"created_by" varchar(255)
);
--> statement-breakpoint
CREATE TABLE "desk_ticket_states" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"ticket_type_id" varchar(30) NOT NULL,
	"category" varchar(25) NOT NULL,
	"internal_label" varchar(255) NOT NULL,
	"external_label" varchar(255) NOT NULL,
	"order" integer DEFAULT 0 NOT NULL,
	"archived" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "desk_ticket_type_attributes" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"ticket_type_id" varchar(30) NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"data_type" varchar(10) NOT NULL,
	"input_options" jsonb,
	"order" integer DEFAULT 0 NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"required_to_create" boolean DEFAULT false NOT NULL,
	"required_to_create_for_contacts" boolean DEFAULT false NOT NULL,
	"visible_on_create" boolean DEFAULT true NOT NULL,
	"visible_to_contacts" boolean DEFAULT true NOT NULL,
	"archived" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "desk_ticket_types" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"icon" varchar(20),
	"category" varchar(15) NOT NULL,
	"archived" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "desk_teammate_settings" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"status" varchar(15) DEFAULT 'active' NOT NULL,
	"assignment_limit" integer,
	"last_assigned_at" timestamp,
	"notification_preferences" jsonb
);
--> statement-breakpoint
CREATE TABLE "desk_teams" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"name" varchar(255) NOT NULL,
	"icon" varchar(20),
	"member_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"distribution_method" varchar(15) DEFAULT 'manual' NOT NULL,
	"team_limit" integer,
	"ignore_away_status" boolean DEFAULT false NOT NULL,
	"office_hours" jsonb,
	"expected_reply_time" varchar(20),
	"inbox_rank" integer DEFAULT 0 NOT NULL,
	"archived" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "desk_views" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"name" varchar(255) NOT NULL,
	"icon" varchar(20),
	"folder" varchar(255),
	"filters" jsonb NOT NULL,
	"sort" varchar(20) DEFAULT 'newest' NOT NULL,
	"shared" boolean DEFAULT false NOT NULL,
	"owner_id" varchar(255) NOT NULL,
	"order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "desk_macros" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"name" varchar(255) NOT NULL,
	"body" text,
	"insert_as" varchar(10) DEFAULT 'reply' NOT NULL,
	"actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"team_ids" jsonb,
	"created_by" varchar(255),
	"archived" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "desk_conversation_slas" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"conversation_id" varchar(30) NOT NULL,
	"sla_id" varchar(30) NOT NULL,
	"status" varchar(10) DEFAULT 'active' NOT NULL,
	"target_states" jsonb NOT NULL,
	"next_deadline" timestamp
);
--> statement-breakpoint
CREATE TABLE "desk_slas" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"name" varchar(255) NOT NULL,
	"conditions" jsonb,
	"targets" jsonb NOT NULL,
	"clock" varchar(15) DEFAULT 'office_hours' NOT NULL,
	"pause_on_snooze" boolean DEFAULT true NOT NULL,
	"pause_on_waiting_on_customer" boolean DEFAULT true NOT NULL,
	"archived" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "desk_office_hours" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"scope" varchar(10) DEFAULT 'default' NOT NULL,
	"timezone" varchar(64) DEFAULT 'UTC' NOT NULL,
	"hours" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "desk_workflow_executions" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"workflow_id" varchar(30) NOT NULL,
	"version_id" varchar(30) NOT NULL,
	"conversation_id" varchar(30) NOT NULL,
	"classification" varchar(20) NOT NULL,
	"status" varchar(15) DEFAULT 'running' NOT NULL,
	"current_path_id" varchar(60),
	"current_step_id" varchar(60),
	"variables" jsonb,
	"parent_execution_id" varchar(30),
	"ended_at" timestamp,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "desk_workflow_trigger_log" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"conversation_id" varchar(30) NOT NULL,
	"trigger" varchar(40) NOT NULL,
	"evaluations" jsonb,
	"execution_id" varchar(30)
);
--> statement-breakpoint
CREATE TABLE "desk_workflow_versions" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"workflow_id" varchar(30) NOT NULL,
	"version_number" integer NOT NULL,
	"graph" jsonb NOT NULL,
	"published_at" timestamp,
	"published_by" varchar(255)
);
--> statement-breakpoint
CREATE TABLE "desk_workflows" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"trigger" varchar(40) NOT NULL,
	"classification" varchar(20) DEFAULT 'background' NOT NULL,
	"status" varchar(10) DEFAULT 'draft' NOT NULL,
	"priority_rank" integer DEFAULT 0 NOT NULL,
	"audience_rules" jsonb,
	"channels" jsonb,
	"scheduling" jsonb,
	"inbox_triggerable" boolean DEFAULT false NOT NULL,
	"live_version_id" varchar(30)
);
--> statement-breakpoint
CREATE TABLE "desk_ai_resolutions" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"conversation_id" varchar(30) NOT NULL,
	"state" varchar(10) DEFAULT 'involved' NOT NULL,
	"answer_count" integer DEFAULT 0 NOT NULL,
	"clarification_count" integer DEFAULT 0 NOT NULL,
	"last_answer_at" timestamp,
	"outcome_at" timestamp,
	"escalation_reason" varchar(30),
	"credit_charge_id" varchar(60),
	"content_sources" jsonb
);
--> statement-breakpoint
CREATE TABLE "desk_ai_settings" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"scope" varchar(10) DEFAULT 'default' NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"agent_name" varchar(100) DEFAULT 'AI Agent' NOT NULL,
	"agent_avatar_url" varchar(500),
	"tone_instructions" text,
	"handover" jsonb,
	"bill_assumed_resolutions" boolean DEFAULT true NOT NULL,
	"assumed_resolution_hours" integer DEFAULT 24 NOT NULL,
	"close_on_resolution" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "desk_article_embeddings" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"article_id" varchar(30) NOT NULL,
	"chunk_index" integer NOT NULL,
	"content_hash" varchar(64) NOT NULL,
	"content" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "desk_news" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"title" varchar(500) NOT NULL,
	"body" text NOT NULL,
	"news_type" varchar(15) DEFAULT 'news' NOT NULL,
	"cover_image_url" varchar(500),
	"audience_rules" jsonb,
	"published_at" timestamp,
	"created_by" varchar(255)
);
--> statement-breakpoint
CREATE TABLE "desk_widget_settings" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"scope" varchar(10) DEFAULT 'default' NOT NULL,
	"widget_id" varchar(40) NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"home_enabled" boolean DEFAULT true NOT NULL,
	"help_enabled" boolean DEFAULT true NOT NULL,
	"home" jsonb,
	"branding" jsonb,
	"identity_verification_secret" text,
	"require_identity_verification" boolean DEFAULT false NOT NULL,
	"email_collection" varchar(15) DEFAULT 'outside_hours' NOT NULL,
	"allowed_domains" jsonb
);
--> statement-breakpoint
CREATE INDEX "desk_conversations_state_waiting_idx" ON "desk_conversations" USING btree ("state","waiting_since");--> statement-breakpoint
CREATE INDEX "desk_conversations_state_created_idx" ON "desk_conversations" USING btree ("state","created_at");--> statement-breakpoint
CREATE INDEX "desk_conversations_admin_assignee_idx" ON "desk_conversations" USING btree ("admin_assignee_id","state");--> statement-breakpoint
CREATE INDEX "desk_conversations_team_assignee_idx" ON "desk_conversations" USING btree ("team_assignee_id","state");--> statement-breakpoint
CREATE INDEX "desk_conversations_contact_idx" ON "desk_conversations" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "desk_conversations_counterparty_idx" ON "desk_conversations" USING btree ("counterparty_id");--> statement-breakpoint
CREATE INDEX "desk_conversations_channel_idx" ON "desk_conversations" USING btree ("channel");--> statement-breakpoint
CREATE INDEX "desk_conversations_number_idx" ON "desk_conversations" USING btree ("conversation_number");--> statement-breakpoint
CREATE INDEX "desk_conversations_ticket_type_idx" ON "desk_conversations" USING btree ("ticket_type_id");--> statement-breakpoint
CREATE INDEX "desk_conversations_ticket_state_idx" ON "desk_conversations" USING btree ("ticket_state_id");--> statement-breakpoint
CREATE INDEX "desk_conversations_snoozed_until_idx" ON "desk_conversations" USING btree ("snoozed_until");--> statement-breakpoint
CREATE INDEX "desk_parts_conversation_created_idx" ON "desk_conversation_parts" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "desk_parts_type_idx" ON "desk_conversation_parts" USING btree ("part_type");--> statement-breakpoint
CREATE INDEX "desk_parts_author_idx" ON "desk_conversation_parts" USING btree ("author_type","author_id");--> statement-breakpoint
CREATE INDEX "desk_parts_email_message_id_idx" ON "desk_conversation_parts" USING btree ("email_message_id");--> statement-breakpoint
CREATE INDEX "desk_conversation_attributes_order_idx" ON "desk_conversation_attributes" USING btree ("order");--> statement-breakpoint
CREATE UNIQUE INDEX "desk_linked_objects_pair_idx" ON "desk_linked_objects" USING btree ("source_id","target_id");--> statement-breakpoint
CREATE INDEX "desk_linked_objects_target_idx" ON "desk_linked_objects" USING btree ("target_id");--> statement-breakpoint
CREATE INDEX "desk_ticket_states_type_idx" ON "desk_ticket_states" USING btree ("ticket_type_id","order");--> statement-breakpoint
CREATE INDEX "desk_ticket_type_attributes_type_idx" ON "desk_ticket_type_attributes" USING btree ("ticket_type_id","order");--> statement-breakpoint
CREATE INDEX "desk_ticket_types_category_idx" ON "desk_ticket_types" USING btree ("category");--> statement-breakpoint
CREATE UNIQUE INDEX "desk_teammate_settings_user_idx" ON "desk_teammate_settings" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "desk_teams_archived_idx" ON "desk_teams" USING btree ("archived");--> statement-breakpoint
CREATE INDEX "desk_views_owner_idx" ON "desk_views" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "desk_macros_archived_idx" ON "desk_macros" USING btree ("archived");--> statement-breakpoint
CREATE UNIQUE INDEX "desk_conversation_slas_conversation_idx" ON "desk_conversation_slas" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "desk_conversation_slas_next_deadline_idx" ON "desk_conversation_slas" USING btree ("status","next_deadline");--> statement-breakpoint
CREATE INDEX "desk_slas_archived_idx" ON "desk_slas" USING btree ("archived");--> statement-breakpoint
CREATE UNIQUE INDEX "desk_office_hours_scope_idx" ON "desk_office_hours" USING btree ("scope");--> statement-breakpoint
CREATE INDEX "desk_workflow_executions_conversation_idx" ON "desk_workflow_executions" USING btree ("conversation_id","status");--> statement-breakpoint
CREATE INDEX "desk_workflow_executions_workflow_idx" ON "desk_workflow_executions" USING btree ("workflow_id","created_at");--> statement-breakpoint
CREATE INDEX "desk_workflow_trigger_log_conversation_idx" ON "desk_workflow_trigger_log" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "desk_workflow_versions_number_idx" ON "desk_workflow_versions" USING btree ("workflow_id","version_number");--> statement-breakpoint
CREATE INDEX "desk_workflows_trigger_idx" ON "desk_workflows" USING btree ("trigger","status");--> statement-breakpoint
CREATE INDEX "desk_workflows_priority_idx" ON "desk_workflows" USING btree ("priority_rank");--> statement-breakpoint
CREATE UNIQUE INDEX "desk_ai_resolutions_conversation_idx" ON "desk_ai_resolutions" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "desk_ai_resolutions_state_answer_idx" ON "desk_ai_resolutions" USING btree ("state","last_answer_at");--> statement-breakpoint
CREATE UNIQUE INDEX "desk_ai_settings_scope_idx" ON "desk_ai_settings" USING btree ("scope");--> statement-breakpoint
CREATE UNIQUE INDEX "desk_article_embeddings_chunk_idx" ON "desk_article_embeddings" USING btree ("article_id","chunk_index");--> statement-breakpoint
CREATE INDEX "desk_news_published_idx" ON "desk_news" USING btree ("published_at");--> statement-breakpoint
CREATE UNIQUE INDEX "desk_widget_settings_scope_idx" ON "desk_widget_settings" USING btree ("scope");--> statement-breakpoint
CREATE UNIQUE INDEX "desk_widget_settings_widget_id_idx" ON "desk_widget_settings" USING btree ("widget_id");