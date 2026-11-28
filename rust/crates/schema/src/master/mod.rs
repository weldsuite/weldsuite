//! The master database: one SeaORM entity per table.

pub mod ad_sync_index;
pub mod admin_audit_events;
pub mod admin_users;
pub mod ai_gateway_credits;
pub mod ai_provider_usage;
pub mod api_key_registry;
pub mod app_catalog;
pub mod app_developer_accounts;
pub mod app_screenshots;
pub mod bank_feed_connection_index;
pub mod billing_accounts;
pub mod billing_invoices;
pub mod billing_payments;
pub mod commerce_connection_registry;
pub mod credit_packages;
pub mod credit_transactions;
pub mod database_pool;
pub mod digest_schedules;
pub mod domain_pricing;
pub mod enterprise_inquiries;
pub mod enums;
pub mod feature_flag_overrides;
pub mod feature_requests;
pub mod form_abuse_reports;
pub mod form_invitation_registry;
pub mod form_link_registry;
pub mod forms_custom_domains;
pub mod helpcenter_domain_registry;
pub mod iceberg_namespace_properties;
pub mod iceberg_tables;
pub mod mail_account_registry;
pub mod mail_dmarc_pool_daily;
pub mod mail_dmarc_report_log;
pub mod mail_domain_registry;
pub mod mail_threat_indicators;
pub mod merge_provider_index;
pub mod neon_shared_projects;
pub mod outbound_mail_cases;
pub mod outbound_mail_events;
pub mod outbound_mail_policies;
pub mod panel_custom_domains;
pub mod panel_erasure_ledger;
pub mod panel_key_registry;
pub mod panel_project_registry;
pub mod panel_schedule_registry;
pub mod panel_share_registry;
pub mod panel_usage_monthly;
pub mod partner_contracts;
pub mod partner_credit_grants;
pub mod partner_licence_packages;
pub mod partner_members;
pub mod partner_statement_lines;
pub mod partner_statements;
pub mod partner_territories;
pub mod partner_workspace_requests;
pub mod partners;
pub mod payroll_usage_events;
pub mod personal_accounts;
pub mod phone_number_registry;
pub mod plans;
pub mod postpeer_post_index;
pub mod reach_routes;
pub mod reach_warmup_mailboxes;
pub mod reach_warmup_messages;
pub mod sign_link_registry;
pub mod storefront_hosts;
pub mod storefront_key_registry;
pub mod system_settings;
pub mod telephony_number_pricing;
pub mod telephony_service_rates;
pub mod telnyx_porting_order_index;
pub mod user_app_dev_sessions;
pub mod user_app_installs;
pub mod user_app_oauth_clients;
pub mod user_app_tokens;
pub mod user_app_versions;
pub mod user_apps;
pub mod user_workspaces;
pub mod users;
pub mod views;
pub mod widget_registry;
pub mod workflow_webhook_registry;
pub mod workspace_app_access;
pub mod workspace_credits;
pub mod workspace_database_moves;
pub mod workspace_due_index;
pub mod workspace_invitations;
pub mod workspace_licence_changes;
pub mod workspace_licences;
pub mod workspace_seat_snapshots;
pub mod workspace_sso;
pub mod workspace_usage;
pub mod workspaces;

/// Every table, from its entity and its DDL, in name order.
pub fn tables() -> Vec<crate::snapshot::TableSchema> {
    vec![
        crate::snapshot::table::<ad_sync_index::Entity>(&ad_sync_index::DDL),
        crate::snapshot::table::<admin_audit_events::Entity>(&admin_audit_events::DDL),
        crate::snapshot::table::<admin_users::Entity>(&admin_users::DDL),
        crate::snapshot::table::<ai_gateway_credits::Entity>(&ai_gateway_credits::DDL),
        crate::snapshot::table::<ai_provider_usage::Entity>(&ai_provider_usage::DDL),
        crate::snapshot::table::<api_key_registry::Entity>(&api_key_registry::DDL),
        crate::snapshot::table::<app_catalog::Entity>(&app_catalog::DDL),
        crate::snapshot::table::<app_developer_accounts::Entity>(&app_developer_accounts::DDL),
        crate::snapshot::table::<app_screenshots::Entity>(&app_screenshots::DDL),
        crate::snapshot::table::<bank_feed_connection_index::Entity>(
            &bank_feed_connection_index::DDL,
        ),
        crate::snapshot::table::<billing_accounts::Entity>(&billing_accounts::DDL),
        crate::snapshot::table::<billing_invoices::Entity>(&billing_invoices::DDL),
        crate::snapshot::table::<billing_payments::Entity>(&billing_payments::DDL),
        crate::snapshot::table::<commerce_connection_registry::Entity>(
            &commerce_connection_registry::DDL,
        ),
        crate::snapshot::table::<credit_packages::Entity>(&credit_packages::DDL),
        crate::snapshot::table::<credit_transactions::Entity>(&credit_transactions::DDL),
        crate::snapshot::table::<database_pool::Entity>(&database_pool::DDL),
        crate::snapshot::table::<digest_schedules::Entity>(&digest_schedules::DDL),
        crate::snapshot::table::<domain_pricing::Entity>(&domain_pricing::DDL),
        crate::snapshot::table::<enterprise_inquiries::Entity>(&enterprise_inquiries::DDL),
        crate::snapshot::table::<feature_flag_overrides::Entity>(&feature_flag_overrides::DDL),
        crate::snapshot::table::<feature_requests::Entity>(&feature_requests::DDL),
        crate::snapshot::table::<form_abuse_reports::Entity>(&form_abuse_reports::DDL),
        crate::snapshot::table::<form_invitation_registry::Entity>(&form_invitation_registry::DDL),
        crate::snapshot::table::<form_link_registry::Entity>(&form_link_registry::DDL),
        crate::snapshot::table::<forms_custom_domains::Entity>(&forms_custom_domains::DDL),
        crate::snapshot::table::<helpcenter_domain_registry::Entity>(
            &helpcenter_domain_registry::DDL,
        ),
        crate::snapshot::table::<iceberg_namespace_properties::Entity>(
            &iceberg_namespace_properties::DDL,
        ),
        crate::snapshot::table::<iceberg_tables::Entity>(&iceberg_tables::DDL),
        crate::snapshot::table::<mail_account_registry::Entity>(&mail_account_registry::DDL),
        crate::snapshot::table::<mail_dmarc_pool_daily::Entity>(&mail_dmarc_pool_daily::DDL),
        crate::snapshot::table::<mail_dmarc_report_log::Entity>(&mail_dmarc_report_log::DDL),
        crate::snapshot::table::<mail_domain_registry::Entity>(&mail_domain_registry::DDL),
        crate::snapshot::table::<mail_threat_indicators::Entity>(&mail_threat_indicators::DDL),
        crate::snapshot::table::<merge_provider_index::Entity>(&merge_provider_index::DDL),
        crate::snapshot::table::<neon_shared_projects::Entity>(&neon_shared_projects::DDL),
        crate::snapshot::table::<outbound_mail_cases::Entity>(&outbound_mail_cases::DDL),
        crate::snapshot::table::<outbound_mail_events::Entity>(&outbound_mail_events::DDL),
        crate::snapshot::table::<outbound_mail_policies::Entity>(&outbound_mail_policies::DDL),
        crate::snapshot::table::<panel_custom_domains::Entity>(&panel_custom_domains::DDL),
        crate::snapshot::table::<panel_erasure_ledger::Entity>(&panel_erasure_ledger::DDL),
        crate::snapshot::table::<panel_key_registry::Entity>(&panel_key_registry::DDL),
        crate::snapshot::table::<panel_project_registry::Entity>(&panel_project_registry::DDL),
        crate::snapshot::table::<panel_schedule_registry::Entity>(&panel_schedule_registry::DDL),
        crate::snapshot::table::<panel_share_registry::Entity>(&panel_share_registry::DDL),
        crate::snapshot::table::<panel_usage_monthly::Entity>(&panel_usage_monthly::DDL),
        crate::snapshot::table::<partner_contracts::Entity>(&partner_contracts::DDL),
        crate::snapshot::table::<partner_credit_grants::Entity>(&partner_credit_grants::DDL),
        crate::snapshot::table::<partner_licence_packages::Entity>(&partner_licence_packages::DDL),
        crate::snapshot::table::<partner_members::Entity>(&partner_members::DDL),
        crate::snapshot::table::<partner_statement_lines::Entity>(&partner_statement_lines::DDL),
        crate::snapshot::table::<partner_statements::Entity>(&partner_statements::DDL),
        crate::snapshot::table::<partner_territories::Entity>(&partner_territories::DDL),
        crate::snapshot::table::<partner_workspace_requests::Entity>(
            &partner_workspace_requests::DDL,
        ),
        crate::snapshot::table::<partners::Entity>(&partners::DDL),
        crate::snapshot::table::<payroll_usage_events::Entity>(&payroll_usage_events::DDL),
        crate::snapshot::table::<personal_accounts::Entity>(&personal_accounts::DDL),
        crate::snapshot::table::<phone_number_registry::Entity>(&phone_number_registry::DDL),
        crate::snapshot::table::<plans::Entity>(&plans::DDL),
        crate::snapshot::table::<postpeer_post_index::Entity>(&postpeer_post_index::DDL),
        crate::snapshot::table::<reach_routes::Entity>(&reach_routes::DDL),
        crate::snapshot::table::<reach_warmup_mailboxes::Entity>(&reach_warmup_mailboxes::DDL),
        crate::snapshot::table::<reach_warmup_messages::Entity>(&reach_warmup_messages::DDL),
        crate::snapshot::table::<sign_link_registry::Entity>(&sign_link_registry::DDL),
        crate::snapshot::table::<storefront_key_registry::Entity>(&storefront_key_registry::DDL),
        crate::snapshot::table::<storefront_hosts::Entity>(&storefront_hosts::DDL),
        crate::snapshot::table::<system_settings::Entity>(&system_settings::DDL),
        crate::snapshot::table::<telephony_number_pricing::Entity>(&telephony_number_pricing::DDL),
        crate::snapshot::table::<telephony_service_rates::Entity>(&telephony_service_rates::DDL),
        crate::snapshot::table::<telnyx_porting_order_index::Entity>(
            &telnyx_porting_order_index::DDL,
        ),
        crate::snapshot::table::<user_app_dev_sessions::Entity>(&user_app_dev_sessions::DDL),
        crate::snapshot::table::<user_app_installs::Entity>(&user_app_installs::DDL),
        crate::snapshot::table::<user_app_oauth_clients::Entity>(&user_app_oauth_clients::DDL),
        crate::snapshot::table::<user_app_tokens::Entity>(&user_app_tokens::DDL),
        crate::snapshot::table::<user_app_versions::Entity>(&user_app_versions::DDL),
        crate::snapshot::table::<user_apps::Entity>(&user_apps::DDL),
        crate::snapshot::table::<user_workspaces::Entity>(&user_workspaces::DDL),
        crate::snapshot::table::<users::Entity>(&users::DDL),
        crate::snapshot::table::<widget_registry::Entity>(&widget_registry::DDL),
        crate::snapshot::table::<workflow_webhook_registry::Entity>(
            &workflow_webhook_registry::DDL,
        ),
        crate::snapshot::table::<workspace_app_access::Entity>(&workspace_app_access::DDL),
        crate::snapshot::table::<workspace_credits::Entity>(&workspace_credits::DDL),
        crate::snapshot::table::<workspace_database_moves::Entity>(&workspace_database_moves::DDL),
        crate::snapshot::table::<workspace_due_index::Entity>(&workspace_due_index::DDL),
        crate::snapshot::table::<workspace_invitations::Entity>(&workspace_invitations::DDL),
        crate::snapshot::table::<workspace_licence_changes::Entity>(
            &workspace_licence_changes::DDL,
        ),
        crate::snapshot::table::<workspace_licences::Entity>(&workspace_licences::DDL),
        crate::snapshot::table::<workspace_seat_snapshots::Entity>(&workspace_seat_snapshots::DDL),
        crate::snapshot::table::<workspace_sso::Entity>(&workspace_sso::DDL),
        crate::snapshot::table::<workspace_usage::Entity>(&workspace_usage::DDL),
        crate::snapshot::table::<workspaces::Entity>(&workspaces::DDL),
    ]
}

/// The database's schema as a drizzle-kit snapshot, without `id` and `prevId`.
pub fn snapshot() -> serde_json::Value {
    crate::snapshot::snapshot(&tables(), &enums::all(), views::VIEWS)
}

/// The database's schema as a typed drizzle-kit snapshot, in the entities' order:
/// what `pnpm db:generate` diffs against the newest migration's.
pub fn schema() -> crate::drizzle::Snapshot {
    crate::snapshot::build(&tables(), &enums::all(), views::VIEWS)
}

/// Every row of `table` through its entity (`Entity::find().all`), as JSON;
/// `None` for a table this database doesn't have. Behind the `all-tables`
/// feature: spike S7 compares it with Drizzle's rows, and S6 measures what a
/// query on every entity costs to build.
#[cfg(feature = "all-tables")]
pub async fn rows_json<C: sea_orm::ConnectionTrait>(
    db: &C,
    table: &str,
) -> Result<Option<Vec<serde_json::Value>>, sea_orm::DbErr> {
    use sea_orm::EntityTrait;
    fn json<T: serde::Serialize>(rows: Vec<T>) -> Vec<serde_json::Value> {
        rows.iter()
            .map(|row| serde_json::to_value(row).unwrap_or_default())
            .collect()
    }
    Ok(Some(match table {
        "ad_sync_index" => json(Box::pin(ad_sync_index::Entity::find().all(db)).await?),
        "admin_audit_events" => json(Box::pin(admin_audit_events::Entity::find().all(db)).await?),
        "admin_users" => json(Box::pin(admin_users::Entity::find().all(db)).await?),
        "ai_gateway_credits" => json(Box::pin(ai_gateway_credits::Entity::find().all(db)).await?),
        "ai_provider_usage" => json(Box::pin(ai_provider_usage::Entity::find().all(db)).await?),
        "api_key_registry" => json(Box::pin(api_key_registry::Entity::find().all(db)).await?),
        "app_catalog" => json(Box::pin(app_catalog::Entity::find().all(db)).await?),
        "app_developer_accounts" => {
            json(Box::pin(app_developer_accounts::Entity::find().all(db)).await?)
        }
        "app_screenshots" => json(Box::pin(app_screenshots::Entity::find().all(db)).await?),
        "bank_feed_connection_index" => {
            json(Box::pin(bank_feed_connection_index::Entity::find().all(db)).await?)
        }
        "billing_accounts" => json(Box::pin(billing_accounts::Entity::find().all(db)).await?),
        "billing_invoices" => json(Box::pin(billing_invoices::Entity::find().all(db)).await?),
        "billing_payments" => json(Box::pin(billing_payments::Entity::find().all(db)).await?),
        "commerce_connection_registry" => {
            json(Box::pin(commerce_connection_registry::Entity::find().all(db)).await?)
        }
        "credit_packages" => json(Box::pin(credit_packages::Entity::find().all(db)).await?),
        "credit_transactions" => json(Box::pin(credit_transactions::Entity::find().all(db)).await?),
        "database_pool" => json(Box::pin(database_pool::Entity::find().all(db)).await?),
        "digest_schedules" => json(Box::pin(digest_schedules::Entity::find().all(db)).await?),
        "domain_pricing" => json(Box::pin(domain_pricing::Entity::find().all(db)).await?),
        "enterprise_inquiries" => {
            json(Box::pin(enterprise_inquiries::Entity::find().all(db)).await?)
        }
        "feature_flag_overrides" => {
            json(Box::pin(feature_flag_overrides::Entity::find().all(db)).await?)
        }
        "feature_requests" => json(Box::pin(feature_requests::Entity::find().all(db)).await?),
        "form_abuse_reports" => json(Box::pin(form_abuse_reports::Entity::find().all(db)).await?),
        "form_invitation_registry" => {
            json(Box::pin(form_invitation_registry::Entity::find().all(db)).await?)
        }
        "form_link_registry" => json(Box::pin(form_link_registry::Entity::find().all(db)).await?),
        "forms_custom_domains" => {
            json(Box::pin(forms_custom_domains::Entity::find().all(db)).await?)
        }
        "helpcenter_domain_registry" => {
            json(Box::pin(helpcenter_domain_registry::Entity::find().all(db)).await?)
        }
        "iceberg_namespace_properties" => {
            json(Box::pin(iceberg_namespace_properties::Entity::find().all(db)).await?)
        }
        "iceberg_tables" => json(Box::pin(iceberg_tables::Entity::find().all(db)).await?),
        "mail_account_registry" => {
            json(Box::pin(mail_account_registry::Entity::find().all(db)).await?)
        }
        "mail_dmarc_pool_daily" => {
            json(Box::pin(mail_dmarc_pool_daily::Entity::find().all(db)).await?)
        }
        "mail_dmarc_report_log" => {
            json(Box::pin(mail_dmarc_report_log::Entity::find().all(db)).await?)
        }
        "mail_domain_registry" => {
            json(Box::pin(mail_domain_registry::Entity::find().all(db)).await?)
        }
        "mail_threat_indicators" => {
            json(Box::pin(mail_threat_indicators::Entity::find().all(db)).await?)
        }
        "merge_provider_index" => {
            json(Box::pin(merge_provider_index::Entity::find().all(db)).await?)
        }
        "neon_shared_projects" => {
            json(Box::pin(neon_shared_projects::Entity::find().all(db)).await?)
        }
        "outbound_mail_cases" => json(Box::pin(outbound_mail_cases::Entity::find().all(db)).await?),
        "outbound_mail_events" => {
            json(Box::pin(outbound_mail_events::Entity::find().all(db)).await?)
        }
        "outbound_mail_policies" => {
            json(Box::pin(outbound_mail_policies::Entity::find().all(db)).await?)
        }
        "panel_custom_domains" => {
            json(Box::pin(panel_custom_domains::Entity::find().all(db)).await?)
        }
        "panel_erasure_ledger" => {
            json(Box::pin(panel_erasure_ledger::Entity::find().all(db)).await?)
        }
        "panel_key_registry" => json(Box::pin(panel_key_registry::Entity::find().all(db)).await?),
        "panel_project_registry" => {
            json(Box::pin(panel_project_registry::Entity::find().all(db)).await?)
        }
        "panel_schedule_registry" => {
            json(Box::pin(panel_schedule_registry::Entity::find().all(db)).await?)
        }
        "panel_share_registry" => {
            json(Box::pin(panel_share_registry::Entity::find().all(db)).await?)
        }
        "panel_usage_monthly" => json(Box::pin(panel_usage_monthly::Entity::find().all(db)).await?),
        "partner_contracts" => json(Box::pin(partner_contracts::Entity::find().all(db)).await?),
        "partner_credit_grants" => {
            json(Box::pin(partner_credit_grants::Entity::find().all(db)).await?)
        }
        "partner_licence_packages" => {
            json(Box::pin(partner_licence_packages::Entity::find().all(db)).await?)
        }
        "partner_members" => json(Box::pin(partner_members::Entity::find().all(db)).await?),
        "partner_statement_lines" => {
            json(Box::pin(partner_statement_lines::Entity::find().all(db)).await?)
        }
        "partner_statements" => json(Box::pin(partner_statements::Entity::find().all(db)).await?),
        "partner_territories" => json(Box::pin(partner_territories::Entity::find().all(db)).await?),
        "partner_workspace_requests" => {
            json(Box::pin(partner_workspace_requests::Entity::find().all(db)).await?)
        }
        "partners" => json(Box::pin(partners::Entity::find().all(db)).await?),
        "payroll_usage_events" => {
            json(Box::pin(payroll_usage_events::Entity::find().all(db)).await?)
        }
        "personal_accounts" => json(Box::pin(personal_accounts::Entity::find().all(db)).await?),
        "phone_number_registry" => {
            json(Box::pin(phone_number_registry::Entity::find().all(db)).await?)
        }
        "plans" => json(Box::pin(plans::Entity::find().all(db)).await?),
        "postpeer_post_index" => json(Box::pin(postpeer_post_index::Entity::find().all(db)).await?),
        "reach_routes" => json(Box::pin(reach_routes::Entity::find().all(db)).await?),
        "reach_warmup_mailboxes" => {
            json(Box::pin(reach_warmup_mailboxes::Entity::find().all(db)).await?)
        }
        "reach_warmup_messages" => {
            json(Box::pin(reach_warmup_messages::Entity::find().all(db)).await?)
        }
        "sign_link_registry" => json(Box::pin(sign_link_registry::Entity::find().all(db)).await?),
        "storefront_hosts" => json(Box::pin(storefront_hosts::Entity::find().all(db)).await?),
        "storefront_key_registry" => {
            json(Box::pin(storefront_key_registry::Entity::find().all(db)).await?)
        }
        "system_settings" => json(Box::pin(system_settings::Entity::find().all(db)).await?),
        "telephony_number_pricing" => {
            json(Box::pin(telephony_number_pricing::Entity::find().all(db)).await?)
        }
        "telephony_service_rates" => {
            json(Box::pin(telephony_service_rates::Entity::find().all(db)).await?)
        }
        "telnyx_porting_order_index" => {
            json(Box::pin(telnyx_porting_order_index::Entity::find().all(db)).await?)
        }
        "user_app_dev_sessions" => {
            json(Box::pin(user_app_dev_sessions::Entity::find().all(db)).await?)
        }
        "user_app_installs" => json(Box::pin(user_app_installs::Entity::find().all(db)).await?),
        "user_app_oauth_clients" => {
            json(Box::pin(user_app_oauth_clients::Entity::find().all(db)).await?)
        }
        "user_app_tokens" => json(Box::pin(user_app_tokens::Entity::find().all(db)).await?),
        "user_app_versions" => json(Box::pin(user_app_versions::Entity::find().all(db)).await?),
        "user_apps" => json(Box::pin(user_apps::Entity::find().all(db)).await?),
        "user_workspaces" => json(Box::pin(user_workspaces::Entity::find().all(db)).await?),
        "users" => json(Box::pin(users::Entity::find().all(db)).await?),
        "widget_registry" => json(Box::pin(widget_registry::Entity::find().all(db)).await?),
        "workflow_webhook_registry" => {
            json(Box::pin(workflow_webhook_registry::Entity::find().all(db)).await?)
        }
        "workspace_app_access" => {
            json(Box::pin(workspace_app_access::Entity::find().all(db)).await?)
        }
        "workspace_credits" => json(Box::pin(workspace_credits::Entity::find().all(db)).await?),
        "workspace_database_moves" => {
            json(Box::pin(workspace_database_moves::Entity::find().all(db)).await?)
        }
        "workspace_due_index" => json(Box::pin(workspace_due_index::Entity::find().all(db)).await?),
        "workspace_invitations" => {
            json(Box::pin(workspace_invitations::Entity::find().all(db)).await?)
        }
        "workspace_licence_changes" => {
            json(Box::pin(workspace_licence_changes::Entity::find().all(db)).await?)
        }
        "workspace_licences" => json(Box::pin(workspace_licences::Entity::find().all(db)).await?),
        "workspace_seat_snapshots" => {
            json(Box::pin(workspace_seat_snapshots::Entity::find().all(db)).await?)
        }
        "workspace_sso" => json(Box::pin(workspace_sso::Entity::find().all(db)).await?),
        "workspace_usage" => json(Box::pin(workspace_usage::Entity::find().all(db)).await?),
        "workspaces" => json(Box::pin(workspaces::Entity::find().all(db)).await?),
        _ => return Ok(None),
    }))
}
