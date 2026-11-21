CREATE TABLE "ai_gateway_credits" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"gateway" varchar(20) NOT NULL,
	"allowance_nano_usd" bigint,
	"manual_adjustment_nano_usd" bigint DEFAULT 0 NOT NULL,
	"allowance_expires_at" timestamp with time zone,
	"reset_policy" varchar(20) DEFAULT 'monthly' NOT NULL,
	"priority" smallint DEFAULT 100 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"exhaustion_margin_nano_usd" bigint DEFAULT 250000000 NOT NULL,
	"spent_nano_usd" bigint DEFAULT 0 NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"last_rolled_up_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_provider_usage" (
	"id" varchar(30) PRIMARY KEY NOT NULL,
	"gateway" varchar(20) NOT NULL,
	"model_id" varchar(200) NOT NULL,
	"workspace_id" varchar(255),
	"op" varchar(30) NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"provider_cost_nano_usd" bigint NOT NULL,
	"covered_by_service_credit" boolean DEFAULT false NOT NULL,
	"credits_charged" integer DEFAULT 0 NOT NULL,
	"reference_type" varchar(50),
	"reference_id" varchar(30),
	"idempotency_key" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_provider_usage" ADD CONSTRAINT "ai_provider_usage_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_gateway_credits_gateway_idx" ON "ai_gateway_credits" USING btree ("gateway");--> statement-breakpoint
CREATE INDEX "ai_gateway_credits_enabled_idx" ON "ai_gateway_credits" USING btree ("enabled");--> statement-breakpoint
CREATE INDEX "ai_provider_usage_gateway_created_idx" ON "ai_provider_usage" USING btree ("gateway","created_at");--> statement-breakpoint
CREATE INDEX "ai_provider_usage_created_at_idx" ON "ai_provider_usage" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "ai_provider_usage_workspace_id_idx" ON "ai_provider_usage" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "ai_provider_usage_model_id_idx" ON "ai_provider_usage" USING btree ("model_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_provider_usage_idempotency_key_idx" ON "ai_provider_usage" USING btree ("idempotency_key");--> statement-breakpoint
DROP TYPE "public"."tenant_tier";--> statement-breakpoint
CREATE TYPE "public"."tenant_tier" AS ENUM('free', 'business', 'scale', 'enterprise');