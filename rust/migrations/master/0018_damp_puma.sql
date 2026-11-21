CREATE TABLE "credit_packages" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"name" varchar(100) NOT NULL,
	"description" text,
	"credits" integer NOT NULL,
	"price" numeric(10, 2) NOT NULL,
	"currency" varchar(3) DEFAULT 'EUR' NOT NULL,
	"stripe_price_id" varchar(255),
	"stripe_product_id" varchar(255),
	"is_popular" integer DEFAULT 0,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_transactions" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"type" varchar(30) NOT NULL,
	"amount" integer NOT NULL,
	"balance_after" integer NOT NULL,
	"service_type" varchar(30),
	"reference_id" varchar(30),
	"reference_type" varchar(50),
	"stripe_payment_intent_id" varchar(255),
	"stripe_checkout_session_id" varchar(255),
	"amount_paid" numeric(10, 2),
	"currency" varchar(3),
	"description" text,
	"metadata" jsonb,
	"user_id" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "weldagent_usage" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"conversation_id" varchar(30),
	"module_key" varchar(50) NOT NULL,
	"model_id" varchar(100) NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"total_tokens" integer NOT NULL,
	"estimated_cost_cents" integer NOT NULL,
	"tools_used" jsonb DEFAULT '[]'::jsonb,
	"tool_call_count" integer DEFAULT 0 NOT NULL,
	"request_duration_ms" integer,
	"was_streamed" boolean DEFAULT true NOT NULL,
	"finish_reason" varchar(50),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "weldagent_usage_summary" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"user_id" varchar(255),
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"period_type" varchar(20) NOT NULL,
	"total_requests" integer DEFAULT 0 NOT NULL,
	"total_input_tokens" integer DEFAULT 0 NOT NULL,
	"total_output_tokens" integer DEFAULT 0 NOT NULL,
	"total_cost_cents" integer DEFAULT 0 NOT NULL,
	"total_tool_calls" integer DEFAULT 0 NOT NULL,
	"usage_by_model" jsonb DEFAULT '{}'::jsonb,
	"usage_by_module" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_credits" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"current_balance" integer DEFAULT 0 NOT NULL,
	"plan_credits" integer DEFAULT 0 NOT NULL,
	"subscribed_credits" integer DEFAULT 0 NOT NULL,
	"monthly_allocation" integer DEFAULT 0 NOT NULL,
	"stripe_credits_item_id" varchar(255),
	"stripe_credits_price_id" varchar(255),
	"rolled_over_credits" integer DEFAULT 0 NOT NULL,
	"rollover_cap" integer,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"last_reset_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_usage" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(255) NOT NULL,
	"task_executions_this_month" integer DEFAULT 0 NOT NULL,
	"task_executions_last_reset" timestamp with time zone DEFAULT now() NOT NULL,
	"emails_sent_this_month" integer DEFAULT 0 NOT NULL,
	"emails_last_reset" timestamp with time zone DEFAULT now() NOT NULL,
	"ai_credits_used_this_month" integer DEFAULT 0 NOT NULL,
	"ai_credits_last_reset" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "credit_transactions" ADD CONSTRAINT "credit_transactions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weldagent_usage" ADD CONSTRAINT "weldagent_usage_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weldagent_usage_summary" ADD CONSTRAINT "weldagent_usage_summary_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_credits" ADD CONSTRAINT "workspace_credits_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_usage" ADD CONSTRAINT "workspace_usage_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credit_packages_active_idx" ON "credit_packages" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "credit_packages_sort_idx" ON "credit_packages" USING btree ("sort_order");--> statement-breakpoint
CREATE INDEX "credit_transactions_workspace_id_idx" ON "credit_transactions" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "credit_transactions_type_idx" ON "credit_transactions" USING btree ("type");--> statement-breakpoint
CREATE INDEX "credit_transactions_service_type_idx" ON "credit_transactions" USING btree ("service_type");--> statement-breakpoint
CREATE INDEX "credit_transactions_reference_idx" ON "credit_transactions" USING btree ("reference_type","reference_id");--> statement-breakpoint
CREATE INDEX "credit_transactions_created_at_idx" ON "credit_transactions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "credit_transactions_stripe_payment_idx" ON "credit_transactions" USING btree ("stripe_payment_intent_id");--> statement-breakpoint
CREATE INDEX "weldagent_usage_workspace_id_idx" ON "weldagent_usage" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "weldagent_usage_user_id_idx" ON "weldagent_usage" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "weldagent_usage_created_at_idx" ON "weldagent_usage" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "weldagent_usage_summary_workspace_id_idx" ON "weldagent_usage_summary" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "weldagent_usage_summary_period_idx" ON "weldagent_usage_summary" USING btree ("period_start","period_end");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_credits_workspace_id_idx" ON "workspace_credits" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "workspace_credits_period_end_idx" ON "workspace_credits" USING btree ("period_end");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_usage_workspace_id_idx" ON "workspace_usage" USING btree ("workspace_id");