DROP MATERIALIZED VIEW "public"."mv_helpdesk_agent_stats";--> statement-breakpoint
DROP MATERIALIZED VIEW "public"."mv_helpdesk_conversations_daily";--> statement-breakpoint
DROP MATERIALIZED VIEW "public"."mv_helpdesk_satisfaction_daily";--> statement-breakpoint
DROP MATERIALIZED VIEW "public"."mv_helpdesk_tickets_daily";--> statement-breakpoint
DROP MATERIALIZED VIEW "public"."mv_crm_activities_daily";--> statement-breakpoint
DROP MATERIALIZED VIEW "public"."mv_crm_leads_daily";--> statement-breakpoint
DROP MATERIALIZED VIEW "public"."mv_crm_opportunities_daily";--> statement-breakpoint
DROP MATERIALIZED VIEW "public"."mv_milestone_stats";--> statement-breakpoint
DROP MATERIALIZED VIEW "public"."mv_projects_summary_daily";--> statement-breakpoint
DROP MATERIALIZED VIEW "public"."mv_tasks_daily";--> statement-breakpoint
DROP MATERIALIZED VIEW "public"."mv_time_entries_daily";--> statement-breakpoint
ALTER TABLE "workspace_credits" DROP CONSTRAINT "workspace_credits_workspace_id_unique";--> statement-breakpoint
ALTER TABLE "device_tokens" DROP CONSTRAINT "device_tokens_user_device_unique";--> statement-breakpoint
ALTER TABLE "social_team_members" DROP CONSTRAINT "social_team_members_unique";--> statement-breakpoint
DROP INDEX "projects_workspace_code_idx";--> statement-breakpoint
DROP INDEX "workflows_workspace_idx";--> statement-breakpoint
DROP INDEX "workflow_executions_workspace_idx";--> statement-breakpoint
DROP INDEX "workflow_execution_steps_workspace_idx";--> statement-breakpoint
DROP INDEX "workflow_triggers_workspace_idx";--> statement-breakpoint
DROP INDEX "workflow_schedules_workspace_idx";--> statement-breakpoint
DROP INDEX "workflow_webhooks_workspace_idx";--> statement-breakpoint
DROP INDEX "workflow_variables_workspace_idx";--> statement-breakpoint
DROP INDEX "workflow_integrations_workspace_idx";--> statement-breakpoint
DROP INDEX "workflow_templates_workspace_idx";--> statement-breakpoint
DROP INDEX "workflow_error_logs_workspace_idx";--> statement-breakpoint
DROP INDEX "pending_uploads_workspace_idx";--> statement-breakpoint
DROP INDEX "workspace_credits_workspace_idx";--> statement-breakpoint
DROP INDEX "credit_transactions_workspace_idx";--> statement-breakpoint
DROP INDEX "customers_workspace_idx";--> statement-breakpoint
DROP INDEX "contacts_workspace_idx";--> statement-breakpoint
DROP INDEX "products_workspace_idx";--> statement-breakpoint
DROP INDEX "categories_workspace_idx";--> statement-breakpoint
DROP INDEX "category_products_workspace_idx";--> statement-breakpoint
DROP INDEX "order_items_workspace_idx";--> statement-breakpoint
DROP INDEX "orders_workspace_idx";--> statement-breakpoint
DROP INDEX "product_connections_workspace_idx";--> statement-breakpoint
DROP INDEX "crm_pipelines_workspace_idx";--> statement-breakpoint
DROP INDEX "crm_pipeline_stages_workspace_idx";--> statement-breakpoint
DROP INDEX "crm_leads_workspace_idx";--> statement-breakpoint
DROP INDEX "crm_opportunities_workspace_idx";--> statement-breakpoint
DROP INDEX "crm_activities_workspace_idx";--> statement-breakpoint
DROP INDEX "crm_transcriptions_workspace_idx";--> statement-breakpoint
DROP INDEX "crm_quotes_workspace_idx";--> statement-breakpoint
DROP INDEX "meeting_bot_sessions_workspace_idx";--> statement-breakpoint
DROP INDEX "telnyx_calls_workspace_idx";--> statement-breakpoint
DROP INDEX "telnyx_phone_numbers_workspace_idx";--> statement-breakpoint
DROP INDEX "commerce_cart_items_workspace_idx";--> statement-breakpoint
DROP INDEX "commerce_carts_workspace_idx";--> statement-breakpoint
DROP INDEX "commerce_discount_usage_workspace_idx";--> statement-breakpoint
DROP INDEX "commerce_discounts_workspace_idx";--> statement-breakpoint
DROP INDEX "woocommerce_connections_workspace_idx";--> statement-breakpoint
DROP INDEX "woocommerce_customers_workspace_idx";--> statement-breakpoint
DROP INDEX "woocommerce_orders_workspace_idx";--> statement-breakpoint
DROP INDEX "woocommerce_products_workspace_idx";--> statement-breakpoint
DROP INDEX "shopify_connections_workspace_idx";--> statement-breakpoint
DROP INDEX "shopify_collections_workspace_idx";--> statement-breakpoint
DROP INDEX "shopify_customers_workspace_idx";--> statement-breakpoint
DROP INDEX "shopify_fulfillments_workspace_idx";--> statement-breakpoint
DROP INDEX "shopify_orders_workspace_idx";--> statement-breakpoint
DROP INDEX "shopify_products_workspace_idx";--> statement-breakpoint
DROP INDEX "shopify_variants_workspace_idx";--> statement-breakpoint
DROP INDEX "sync_logs_workspace_idx";--> statement-breakpoint
DROP INDEX "commerce_websites_workspace_idx";--> statement-breakpoint
DROP INDEX "commerce_website_pages_workspace_idx";--> statement-breakpoint
DROP INDEX "commerce_website_sections_workspace_idx";--> statement-breakpoint
DROP INDEX "commerce_website_domains_workspace_idx";--> statement-breakpoint
DROP INDEX "domains_workspace_id_idx";--> statement-breakpoint
DROP INDEX "dns_zones_workspace_id_idx";--> statement-breakpoint
DROP INDEX "dns_records_workspace_id_idx";--> statement-breakpoint
DROP INDEX "email_forwards_workspace_id_idx";--> statement-breakpoint
DROP INDEX "domain_transfers_workspace_id_idx";--> statement-breakpoint
DROP INDEX "mail_accounts_workspace_id_idx";--> statement-breakpoint
DROP INDEX "mail_domains_workspace_id_idx";--> statement-breakpoint
DROP INDEX "mail_folders_workspace_id_idx";--> statement-breakpoint
DROP INDEX "mail_messages_workspace_id_idx";--> statement-breakpoint
DROP INDEX "mail_attachments_workspace_id_idx";--> statement-breakpoint
DROP INDEX "mail_drafts_workspace_id_idx";--> statement-breakpoint
DROP INDEX "mail_templates_workspace_id_idx";--> statement-breakpoint
DROP INDEX "mail_campaigns_workspace_id_idx";--> statement-breakpoint
DROP INDEX "mail_rules_workspace_id_idx";--> statement-breakpoint
DROP INDEX "mail_signatures_workspace_id_idx";--> statement-breakpoint
DROP INDEX "mail_contacts_workspace_id_idx";--> statement-breakpoint
DROP INDEX "mail_labels_workspace_id_idx";--> statement-breakpoint
DROP INDEX "helpdesk_agents_workspace_idx";--> statement-breakpoint
DROP INDEX "helpdesk_departments_workspace_idx";--> statement-breakpoint
DROP INDEX "helpdesk_conversations_workspace_idx";--> statement-breakpoint
DROP INDEX "helpdesk_conv_messages_workspace_idx";--> statement-breakpoint
DROP INDEX "helpdesk_tickets_workspace_idx";--> statement-breakpoint
DROP INDEX "helpdesk_ticket_messages_workspace_idx";--> statement-breakpoint
DROP INDEX "helpdesk_ticket_notes_workspace_idx";--> statement-breakpoint
DROP INDEX "helpdesk_article_folders_workspace_idx";--> statement-breakpoint
DROP INDEX "helpdesk_articles_workspace_idx";--> statement-breakpoint
DROP INDEX "helpdesk_faqs_workspace_idx";--> statement-breakpoint
DROP INDEX "helpdesk_slas_workspace_idx";--> statement-breakpoint
DROP INDEX "helpdesk_canned_responses_workspace_idx";--> statement-breakpoint
DROP INDEX "helpdesk_contacts_workspace_idx";--> statement-breakpoint
DROP INDEX "helpdesk_announcements_workspace_idx";--> statement-breakpoint
DROP INDEX "helpdesk_changelog_workspace_idx";--> statement-breakpoint
DROP INDEX "helpdesk_news_workspace_idx";--> statement-breakpoint
DROP INDEX "helpdesk_feedback_workspace_idx";--> statement-breakpoint
DROP INDEX "helpdesk_reviews_workspace_idx";--> statement-breakpoint
DROP INDEX "helpdesk_satisfaction_surveys_workspace_idx";--> statement-breakpoint
DROP INDEX "helpdesk_settings_workspace_idx";--> statement-breakpoint
DROP INDEX "helpdesk_widget_settings_workspace_idx";--> statement-breakpoint
DROP INDEX "helpdesk_channel_integrations_workspace_idx";--> statement-breakpoint
DROP INDEX "helpdesk_analytics_reports_workspace_idx";--> statement-breakpoint
DROP INDEX "helpdesk_analytics_charts_workspace_idx";--> statement-breakpoint
DROP INDEX "analytics_reports_workspace_app_idx";--> statement-breakpoint
DROP INDEX "analytics_charts_workspace_app_idx";--> statement-breakpoint
DROP INDEX "carriers_workspace_idx";--> statement-breakpoint
DROP INDEX "carrier_services_workspace_idx";--> statement-breakpoint
DROP INDEX "boxes_workspace_idx";--> statement-breakpoint
DROP INDEX "parcels_workspace_idx";--> statement-breakpoint
DROP INDEX "shipments_workspace_idx";--> statement-breakpoint
DROP INDEX "tracking_events_workspace_idx";--> statement-breakpoint
DROP INDEX "pickups_workspace_idx";--> statement-breakpoint
DROP INDEX "returns_workspace_idx";--> statement-breakpoint
DROP INDEX "return_reason_groups_workspace_idx";--> statement-breakpoint
DROP INDEX "return_reasons_workspace_idx";--> statement-breakpoint
DROP INDEX "return_rules_workspace_idx";--> statement-breakpoint
DROP INDEX "shipping_rules_workspace_idx";--> statement-breakpoint
DROP INDEX "shipping_prices_workspace_idx";--> statement-breakpoint
DROP INDEX "email_templates_workspace_idx";--> statement-breakpoint
DROP INDEX "sms_templates_workspace_idx";--> statement-breakpoint
DROP INDEX "whatsapp_templates_workspace_idx";--> statement-breakpoint
DROP INDEX "wallet_transactions_workspace_idx";--> statement-breakpoint
DROP INDEX "wallets_workspace_idx";--> statement-breakpoint
DROP INDEX "warehouses_workspace_idx";--> statement-breakpoint
DROP INDEX "warehouse_zones_workspace_idx";--> statement-breakpoint
DROP INDEX "warehouse_locations_workspace_idx";--> statement-breakpoint
DROP INDEX "inventory_workspace_idx";--> statement-breakpoint
DROP INDEX "stock_adjustments_workspace_idx";--> statement-breakpoint
DROP INDEX "suppliers_workspace_idx";--> statement-breakpoint
DROP INDEX "purchase_orders_workspace_idx";--> statement-breakpoint
DROP INDEX "po_items_workspace_idx";--> statement-breakpoint
DROP INDEX "pick_lists_workspace_idx";--> statement-breakpoint
DROP INDEX "pick_list_items_workspace_idx";--> statement-breakpoint
DROP INDEX "cycle_count_items_workspace_idx";--> statement-breakpoint
DROP INDEX "cycle_counts_workspace_idx";--> statement-breakpoint
DROP INDEX "inventory_movements_workspace_idx";--> statement-breakpoint
DROP INDEX "external_webhooks_workspace_idx";--> statement-breakpoint
DROP INDEX "webhook_deliveries_workspace_idx";--> statement-breakpoint
DROP INDEX "weldagent_conversations_workspace_user_idx";--> statement-breakpoint
DROP INDEX "device_tokens_workspace_idx";--> statement-breakpoint
DROP INDEX "social_accounts_workspace_idx";--> statement-breakpoint
DROP INDEX "social_posts_workspace_idx";--> statement-breakpoint
DROP INDEX "social_media_workspace_idx";--> statement-breakpoint
DROP INDEX "social_analytics_workspace_idx";--> statement-breakpoint
DROP INDEX "social_team_members_workspace_idx";--> statement-breakpoint
DROP INDEX "social_approval_history_workspace_idx";--> statement-breakpoint
DROP INDEX "social_approvals_workspace_idx";--> statement-breakpoint
DROP INDEX "social_campaigns_workspace_idx";--> statement-breakpoint
DROP INDEX "social_accounts_platform_account_idx";--> statement-breakpoint
CREATE INDEX "analytics_reports_app_idx" ON "analytics_reports" USING btree ("app");--> statement-breakpoint
CREATE INDEX "analytics_charts_app_idx" ON "analytics_charts" USING btree ("app");--> statement-breakpoint
CREATE INDEX "weldagent_conversations_user_idx" ON "weldagent_conversations" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "social_accounts_platform_account_idx" ON "social_accounts" USING btree ("platform","platform_account_id");--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "time_entries" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "project_members" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "milestones" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "project_files" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "project_messages" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "sprints" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "project_whiteboards" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "project_documents" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "project_goals" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "workflows" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "workflow_executions" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "workflow_execution_steps" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "workflow_triggers" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "workflow_schedules" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "workflow_webhooks" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "workflow_variables" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "workflow_integrations" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "workflow_templates" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "workflow_error_logs" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "pending_uploads" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "workspace_credits" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "credit_transactions" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "customers" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "contacts" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "products" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "categories" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "category_products" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "order_items" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "orders" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "product_connections" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "crm_pipelines" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "crm_pipeline_stages" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "crm_leads" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "crm_opportunities" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "crm_activities" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "crm_transcriptions" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "crm_quotes" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "meeting_bot_sessions" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "telnyx_calls" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "telnyx_phone_numbers" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "commerce_cart_items" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "commerce_carts" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "commerce_discount_usage" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "commerce_discounts" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "woocommerce_connections" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "woocommerce_customers" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "woocommerce_orders" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "woocommerce_products" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "shopify_connections" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "shopify_collections" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "shopify_customers" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "shopify_fulfillments" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "shopify_orders" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "shopify_products" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "shopify_variants" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "sync_logs" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "commerce_websites" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "commerce_website_pages" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "commerce_website_sections" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "commerce_website_domains" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "domains" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "dns_zones" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "dns_records" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "email_forwards" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "domain_transfers" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "mail_accounts" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "mail_domains" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "mail_folders" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "mail_messages" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "mail_attachments" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "mail_drafts" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "mail_templates" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "mail_campaigns" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "mail_rules" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "mail_signatures" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "mail_contacts" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "mail_labels" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "helpdesk_agents" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "helpdesk_departments" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "helpdesk_conversations" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "helpdesk_conversation_messages" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "helpdesk_tickets" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "helpdesk_ticket_messages" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "helpdesk_ticket_notes" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "helpdesk_article_folders" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "helpdesk_articles" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "helpdesk_faqs" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "helpdesk_slas" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "helpdesk_canned_responses" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "helpdesk_contacts" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "helpdesk_announcements" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "helpdesk_changelog" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "helpdesk_news" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "helpdesk_feedback" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "helpdesk_reviews" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "helpdesk_satisfaction_surveys" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "helpdesk_settings" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "helpdesk_widget_settings" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "helpdesk_channel_integrations" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "helpdesk_analytics_reports" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "helpdesk_analytics_charts" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "analytics_reports" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "analytics_charts" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "carriers" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "carrier_services" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "boxes" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "parcels" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "shipments" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "tracking_events" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "pickups" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "returns" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "return_reason_groups" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "return_reasons" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "return_rules" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "shipping_rules" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "shipping_prices" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "email_templates" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "sms_templates" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "whatsapp_templates" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "wallet_transactions" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "wallets" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "warehouses" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "warehouse_zones" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "warehouse_locations" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "inventory" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "stock_adjustments" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "suppliers" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "purchase_orders" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "purchase_order_items" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "pick_lists" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "pick_list_items" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "cycle_count_items" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "cycle_counts" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "inventory_movements" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "user_preferences" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "external_webhooks" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "webhook_deliveries" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "weldagent_user_settings" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "weldagent_usage" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "weldagent_usage_summary" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "weldagent_conversations" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "weldagent_messages" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "device_tokens" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "social_accounts" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "social_posts" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "social_media" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "social_analytics" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "social_team_members" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "social_approval_history" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "social_approvals" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "social_campaigns" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "device_tokens" ADD CONSTRAINT "device_tokens_user_device_unique" UNIQUE("user_id","device_id");--> statement-breakpoint
ALTER TABLE "social_team_members" ADD CONSTRAINT "social_team_members_unique" UNIQUE("user_id");--> statement-breakpoint
CREATE MATERIALIZED VIEW "public"."mv_helpdesk_agent_stats" AS (select "id", "name", "status", "tickets_resolved", "tickets_assigned", "average_response_time", "satisfaction_score" from "helpdesk_agents" where "helpdesk_agents"."deleted_at" IS NULL) WITH NO DATA;--> statement-breakpoint
CREATE MATERIALIZED VIEW "public"."mv_helpdesk_conversations_daily" AS (select DATE_TRUNC('day', "created_at") as "period", "status", "channel", COUNT(*) as "conversation_count", AVG("message_count") as "avg_messages" from "helpdesk_conversations" where "helpdesk_conversations"."deleted_at" IS NULL group by DATE_TRUNC('day', "helpdesk_conversations"."created_at"), "helpdesk_conversations"."status", "helpdesk_conversations"."channel") WITH NO DATA;--> statement-breakpoint
CREATE MATERIALIZED VIEW "public"."mv_helpdesk_satisfaction_daily" AS (select DATE_TRUNC('day', "sent_at") as "period", COUNT(*) as "survey_count", COUNT(*) FILTER (WHERE "status" = 'completed') as "completed_count", AVG("rating") FILTER (WHERE "status" = 'completed') as "avg_rating", COUNT(*) FILTER (WHERE "rating" >= 9) as "promoters", COUNT(*) FILTER (WHERE "rating" <= 6) as "detractors" from "helpdesk_satisfaction_surveys" where "helpdesk_satisfaction_surveys"."deleted_at" IS NULL group by DATE_TRUNC('day', "helpdesk_satisfaction_surveys"."sent_at")) WITH NO DATA;--> statement-breakpoint
CREATE MATERIALIZED VIEW "public"."mv_helpdesk_tickets_daily" AS (select DATE_TRUNC('day', "created_at") as "period", "status", "priority", "channel", COUNT(*) as "ticket_count", COUNT(*) FILTER (WHERE "is_escalated" = true) as "escalated_count", AVG("response_time") FILTER (WHERE "response_time" IS NOT NULL) as "avg_response_time", AVG("resolution_time") FILTER (WHERE "resolution_time" IS NOT NULL) as "avg_resolution_time" from "helpdesk_tickets" where "helpdesk_tickets"."deleted_at" IS NULL group by DATE_TRUNC('day', "helpdesk_tickets"."created_at"), "helpdesk_tickets"."status", "helpdesk_tickets"."priority", "helpdesk_tickets"."channel") WITH NO DATA;--> statement-breakpoint
CREATE MATERIALIZED VIEW "public"."mv_crm_activities_daily" AS (select DATE_TRUNC('day', "created_at") as "period", "type", "status", "related_to", "call_direction", COUNT(*) as "activity_count", COUNT(*) FILTER (WHERE "status" = 'completed') as "completed_count", AVG("duration") FILTER (WHERE "duration" IS NOT NULL) as "avg_duration", SUM("duration") FILTER (WHERE "duration" IS NOT NULL) as "total_duration", AVG("call_duration") FILTER (WHERE "call_duration" IS NOT NULL) as "avg_call_duration", SUM("call_duration") FILTER (WHERE "call_duration" IS NOT NULL) as "total_call_duration", COUNT(*) FILTER (WHERE "call_direction" = 'inbound') as "inbound_calls", COUNT(*) FILTER (WHERE "call_direction" = 'outbound') as "outbound_calls" from "crm_activities" where "crm_activities"."deleted_at" IS NULL group by DATE_TRUNC('day', "crm_activities"."created_at"), "crm_activities"."type", "crm_activities"."status", "crm_activities"."related_to", "crm_activities"."call_direction") WITH NO DATA;--> statement-breakpoint
CREATE MATERIALIZED VIEW "public"."mv_crm_leads_daily" AS (select DATE_TRUNC('day', "created_at") as "period", "status", "source", "rating", COUNT(*) as "lead_count", COUNT(*) FILTER (WHERE "is_qualified" = true) as "qualified_count", COUNT(*) FILTER (WHERE "converted_at" IS NOT NULL) as "converted_count", AVG("score") as "avg_score", AVG(EXTRACT(EPOCH FROM ("converted_at" - "created_at")) / 3600) FILTER (WHERE "converted_at" IS NOT NULL) as "avg_time_to_convert", AVG(EXTRACT(EPOCH FROM ("qualified_at" - "created_at")) / 3600) FILTER (WHERE "qualified_at" IS NOT NULL) as "avg_time_to_qualify", AVG(EXTRACT(EPOCH FROM ("first_response_at" - "created_at")) / 3600) FILTER (WHERE "first_response_at" IS NOT NULL) as "avg_time_to_first_response" from "crm_leads" where "crm_leads"."deleted_at" IS NULL group by DATE_TRUNC('day', "crm_leads"."created_at"), "crm_leads"."status", "crm_leads"."source", "crm_leads"."rating") WITH NO DATA;--> statement-breakpoint
CREATE MATERIALIZED VIEW "public"."mv_crm_opportunities_daily" AS (select DATE_TRUNC('day', "created_at") as "period", "stage", "status", "forecast_category", "risk_level", COUNT(*) as "opportunity_count", COUNT(*) FILTER (WHERE "status" = 'won') as "won_count", COUNT(*) FILTER (WHERE "status" = 'lost') as "lost_count", SUM("amount") as "total_amount", AVG("amount") as "avg_amount", SUM("amount" * "probability" / 100) as "weighted_amount", SUM("amount") FILTER (WHERE "status" = 'won') as "won_amount", SUM("amount") FILTER (WHERE "status" = 'lost') as "lost_amount", AVG("probability") as "avg_probability", AVG("days_in_current_stage") as "avg_days_in_stage" from "crm_opportunities" where "crm_opportunities"."deleted_at" IS NULL group by DATE_TRUNC('day', "crm_opportunities"."created_at"), "crm_opportunities"."stage", "crm_opportunities"."status", "crm_opportunities"."forecast_category", "crm_opportunities"."risk_level") WITH NO DATA;--> statement-breakpoint
CREATE MATERIALIZED VIEW "public"."mv_milestone_stats" AS (select "project_id", "id", "name", "status", "due_date", "completed_at", "progress", "completed_tasks", "total_tasks", CASE WHEN "due_date" < NOW() AND "status" != 'completed' THEN true ELSE false END as "is_overdue", CASE WHEN "completed_at" IS NOT NULL AND "completed_at" <= "due_date" THEN true ELSE false END as "is_on_time", "is_key_milestone" from "milestones" where "milestones"."deleted_at" IS NULL) WITH NO DATA;--> statement-breakpoint
CREATE MATERIALIZED VIEW "public"."mv_projects_summary_daily" AS (select DATE_TRUNC('day', "created_at") as "period", "id", "status", "health", COUNT(*) as "project_count", COUNT(*) FILTER (WHERE "is_active" = true) as "active_count", SUM("budgeted_hours") as "total_budgeted_hours", SUM("actual_hours") as "total_actual_hours", SUM("budgeted_amount") as "total_budgeted_amount", SUM("actual_amount") as "total_actual_amount", AVG("progress") as "avg_progress", SUM("total_tasks") as "total_tasks", SUM("completed_tasks") as "completed_tasks", SUM("total_milestones") as "total_milestones", SUM("completed_milestones") as "completed_milestones" from "projects" where "projects"."deleted_at" IS NULL group by DATE_TRUNC('day', "projects"."created_at"), "projects"."id", "projects"."status", "projects"."health") WITH NO DATA;--> statement-breakpoint
CREATE MATERIALIZED VIEW "public"."mv_tasks_daily" AS (select DATE_TRUNC('day', "created_at") as "period", "project_id", "status", "priority", "type", COUNT(*) as "task_count", COUNT(*) FILTER (WHERE "status" = 'done') as "completed_count", COUNT(*) FILTER (WHERE "due_date" < NOW() AND "status" != 'done' AND "status" != 'cancelled') as "overdue_count", SUM("estimated_hours") as "total_estimated_hours", SUM("actual_hours") as "total_actual_hours", AVG("progress") as "avg_progress" from "tasks" where "tasks"."deleted_at" IS NULL group by DATE_TRUNC('day', "tasks"."created_at"), "tasks"."project_id", "tasks"."status", "tasks"."priority", "tasks"."type") WITH NO DATA;--> statement-breakpoint
CREATE MATERIALIZED VIEW "public"."mv_time_entries_daily" AS (select DATE_TRUNC('day', "date"::timestamp) as "period", "project_id", "user_id", "status", COUNT(*) as "entry_count", SUM("duration") as "total_duration", SUM("duration") FILTER (WHERE "billable" = true) as "billable_duration", SUM("duration") FILTER (WHERE "billable" = false) as "non_billable_duration", SUM("cost") as "total_cost", AVG("rate") FILTER (WHERE "rate" IS NOT NULL) as "avg_rate" from "time_entries" where "time_entries"."deleted_at" IS NULL group by DATE_TRUNC('day', "time_entries"."date"::timestamp), "time_entries"."project_id", "time_entries"."user_id", "time_entries"."status") WITH NO DATA;