CREATE TABLE "helpdesk_workflow_executions" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"helpdesk_workflow_id" varchar(30) NOT NULL,
	"workflow_version" integer DEFAULT 1 NOT NULL,
	"workflow_name" varchar(255),
	"status" varchar(20) DEFAULT 'queued' NOT NULL,
	"triggered_by" varchar(255),
	"trigger_type" varchar(30),
	"trigger_id" varchar(30),
	"trigger_data" jsonb,
	"conversation_id" varchar(30),
	"channel" varchar(30),
	"started_at" timestamp,
	"completed_at" timestamp,
	"duration" integer,
	"current_step_id" varchar(50),
	"current_step_index" integer DEFAULT 0,
	"total_steps" integer DEFAULT 0,
	"output" jsonb,
	"error" jsonb,
	"execution_context" jsonb,
	"retry_count" integer DEFAULT 0,
	"parent_execution_id" varchar(30)
);
--> statement-breakpoint
CREATE TABLE "helpdesk_workflow_execution_steps" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"execution_id" varchar(30) NOT NULL,
	"step_id" varchar(50) NOT NULL,
	"step_name" varchar(255),
	"step_type" varchar(100),
	"step_index" integer DEFAULT 0 NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"started_at" timestamp,
	"completed_at" timestamp,
	"duration" integer,
	"input" jsonb,
	"output" jsonb,
	"error" jsonb,
	"retry_count" integer DEFAULT 0,
	"max_retries" integer DEFAULT 0,
	"logs" jsonb
);
--> statement-breakpoint
CREATE TABLE "helpdesk_workflow_error_logs" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"helpdesk_workflow_id" varchar(30),
	"execution_id" varchar(30),
	"conversation_id" varchar(30),
	"error_code" varchar(50),
	"error_message" text NOT NULL,
	"error_type" varchar(100),
	"severity" varchar(20) DEFAULT 'error' NOT NULL,
	"stack_trace" text,
	"step_id" varchar(50),
	"step_name" varchar(255),
	"step_type" varchar(100),
	"input" jsonb,
	"context" jsonb,
	"is_acknowledged" boolean DEFAULT false NOT NULL,
	"acknowledged_by" varchar(255),
	"acknowledged_at" timestamp,
	"acknowledged_note" text,
	"occurred_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "helpdesk_workflow_variables" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"helpdesk_workflow_id" varchar(30),
	"name" varchar(255) NOT NULL,
	"description" text,
	"scope" varchar(20) DEFAULT 'workflow' NOT NULL,
	"type" varchar(20) DEFAULT 'string' NOT NULL,
	"value" jsonb,
	"default_value" jsonb,
	"is_secret" boolean DEFAULT false NOT NULL,
	"is_encrypted" boolean DEFAULT false NOT NULL,
	"encrypted_value" text,
	"category" varchar(100),
	"tags" jsonb,
	"modified_by" varchar(255)
);
--> statement-breakpoint
ALTER TABLE "helpdesk_workflow_executions" ADD CONSTRAINT "helpdesk_workflow_executions_helpdesk_workflow_id_helpdesk_workflows_id_fk" FOREIGN KEY ("helpdesk_workflow_id") REFERENCES "public"."helpdesk_workflows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "helpdesk_workflow_execution_steps" ADD CONSTRAINT "helpdesk_workflow_execution_steps_execution_id_helpdesk_workflow_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."helpdesk_workflow_executions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "helpdesk_workflow_error_logs" ADD CONSTRAINT "helpdesk_workflow_error_logs_helpdesk_workflow_id_helpdesk_workflows_id_fk" FOREIGN KEY ("helpdesk_workflow_id") REFERENCES "public"."helpdesk_workflows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "helpdesk_workflow_error_logs" ADD CONSTRAINT "helpdesk_workflow_error_logs_execution_id_helpdesk_workflow_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."helpdesk_workflow_executions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "helpdesk_workflow_variables" ADD CONSTRAINT "helpdesk_workflow_variables_helpdesk_workflow_id_helpdesk_workflows_id_fk" FOREIGN KEY ("helpdesk_workflow_id") REFERENCES "public"."helpdesk_workflows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "hd_wf_exec_workflow_idx" ON "helpdesk_workflow_executions" USING btree ("helpdesk_workflow_id");--> statement-breakpoint
CREATE INDEX "hd_wf_exec_status_idx" ON "helpdesk_workflow_executions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "hd_wf_exec_triggered_by_idx" ON "helpdesk_workflow_executions" USING btree ("triggered_by");--> statement-breakpoint
CREATE INDEX "hd_wf_exec_trigger_type_idx" ON "helpdesk_workflow_executions" USING btree ("trigger_type");--> statement-breakpoint
CREATE INDEX "hd_wf_exec_conversation_idx" ON "helpdesk_workflow_executions" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "hd_wf_exec_started_at_idx" ON "helpdesk_workflow_executions" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "hd_wf_exec_steps_execution_idx" ON "helpdesk_workflow_execution_steps" USING btree ("execution_id");--> statement-breakpoint
CREATE INDEX "hd_wf_exec_steps_step_idx" ON "helpdesk_workflow_execution_steps" USING btree ("step_id");--> statement-breakpoint
CREATE INDEX "hd_wf_exec_steps_status_idx" ON "helpdesk_workflow_execution_steps" USING btree ("status");--> statement-breakpoint
CREATE INDEX "hd_wf_error_logs_workflow_idx" ON "helpdesk_workflow_error_logs" USING btree ("helpdesk_workflow_id");--> statement-breakpoint
CREATE INDEX "hd_wf_error_logs_execution_idx" ON "helpdesk_workflow_error_logs" USING btree ("execution_id");--> statement-breakpoint
CREATE INDEX "hd_wf_error_logs_conversation_idx" ON "helpdesk_workflow_error_logs" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "hd_wf_error_logs_severity_idx" ON "helpdesk_workflow_error_logs" USING btree ("severity");--> statement-breakpoint
CREATE INDEX "hd_wf_error_logs_is_ack_idx" ON "helpdesk_workflow_error_logs" USING btree ("is_acknowledged");--> statement-breakpoint
CREATE INDEX "hd_wf_error_logs_occurred_at_idx" ON "helpdesk_workflow_error_logs" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "hd_wf_variables_workflow_idx" ON "helpdesk_workflow_variables" USING btree ("helpdesk_workflow_id");--> statement-breakpoint
CREATE INDEX "hd_wf_variables_scope_idx" ON "helpdesk_workflow_variables" USING btree ("scope");--> statement-breakpoint
CREATE INDEX "hd_wf_variables_name_idx" ON "helpdesk_workflow_variables" USING btree ("name");--> statement-breakpoint
CREATE INDEX "hd_wf_variables_is_secret_idx" ON "helpdesk_workflow_variables" USING btree ("is_secret");