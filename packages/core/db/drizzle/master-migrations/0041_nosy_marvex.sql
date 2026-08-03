ALTER TABLE "ai_provider_usage" DROP CONSTRAINT "ai_provider_usage_workspace_id_workspaces_id_fk";
--> statement-breakpoint
ALTER TABLE "api_key_registry" DROP CONSTRAINT "api_key_registry_workspace_id_workspaces_id_fk";
--> statement-breakpoint
ALTER TABLE "billing_invoices" DROP CONSTRAINT "billing_invoices_workspace_id_workspaces_id_fk";
--> statement-breakpoint
ALTER TABLE "billing_payments" DROP CONSTRAINT "billing_payments_workspace_id_workspaces_id_fk";
--> statement-breakpoint
ALTER TABLE "billing_payments" DROP CONSTRAINT "billing_payments_invoice_id_billing_invoices_id_fk";
--> statement-breakpoint
ALTER TABLE "credit_transactions" DROP CONSTRAINT "credit_transactions_workspace_id_workspaces_id_fk";
--> statement-breakpoint
ALTER TABLE "digest_schedules" DROP CONSTRAINT "digest_schedules_workspace_id_workspaces_id_fk";
--> statement-breakpoint
ALTER TABLE "helpcenter_domain_registry" DROP CONSTRAINT "helpcenter_domain_registry_workspace_id_workspaces_id_fk";
--> statement-breakpoint
ALTER TABLE "mail_account_registry" DROP CONSTRAINT "mail_account_registry_workspace_id_workspaces_id_fk";
--> statement-breakpoint
ALTER TABLE "user_workspaces" DROP CONSTRAINT "user_workspaces_workspace_id_workspaces_id_fk";
--> statement-breakpoint
ALTER TABLE "widget_registry" DROP CONSTRAINT "widget_registry_workspace_id_workspaces_id_fk";
--> statement-breakpoint
ALTER TABLE "workspace_credits" DROP CONSTRAINT "workspace_credits_workspace_id_workspaces_id_fk";
--> statement-breakpoint
ALTER TABLE "workspace_usage" DROP CONSTRAINT "workspace_usage_workspace_id_workspaces_id_fk";
--> statement-breakpoint
ALTER TABLE "ai_provider_usage" ADD CONSTRAINT "ai_provider_usage_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_key_registry" ADD CONSTRAINT "api_key_registry_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_invoices" ADD CONSTRAINT "billing_invoices_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_payments" ADD CONSTRAINT "billing_payments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_payments" ADD CONSTRAINT "billing_payments_invoice_id_billing_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."billing_invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_transactions" ADD CONSTRAINT "credit_transactions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digest_schedules" ADD CONSTRAINT "digest_schedules_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "helpcenter_domain_registry" ADD CONSTRAINT "helpcenter_domain_registry_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_account_registry" ADD CONSTRAINT "mail_account_registry_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_workspaces" ADD CONSTRAINT "user_workspaces_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "widget_registry" ADD CONSTRAINT "widget_registry_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_credits" ADD CONSTRAINT "workspace_credits_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_usage" ADD CONSTRAINT "workspace_usage_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;