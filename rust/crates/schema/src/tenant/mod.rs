//! The tenant database: one SeaORM entity per table.

pub mod access_requests;
pub mod accounting_bank_account_settings;
pub mod accounting_contacts;
pub mod accounting_dimension_values;
pub mod accounting_entity_settings;
pub mod accounts;
pub mod active_timers;
pub mod activity_logs;
pub mod ad_accounts;
pub mod ad_campaigns;
pub mod ad_platform_connections;
pub mod ai_provider_keys;
pub mod ai_settings;
pub mod analytics_charts;
pub mod analytics_reports;
pub mod api_keys;
pub mod app_kv;
pub mod app_records;
pub mod asset_sources;
pub mod audit_log;
pub mod audit_log_streams;
pub mod audit_logs;
pub mod bank_accounts;
pub mod bank_connections;
pub mod bank_deposits;
pub mod bank_feed_pending_transactions;
pub mod bank_import_batches;
pub mod bank_reconciliations;
pub mod bank_transactions;
pub mod bill_items;
pub mod bills;
pub mod board_versions;
pub mod boxes;
pub mod calendar_booking_pages;
pub mod calendar_bookings;
pub mod calendar_events;
pub mod calendar_shares;
pub mod calendars;
pub mod carrier_services;
pub mod carriers;
pub mod categories;
pub mod category_products;
pub mod chat_bookmarks;
pub mod chat_calls;
pub mod chat_channel_members;
pub mod chat_channel_role_links;
pub mod chat_channels;
pub mod chat_drafts;
pub mod chat_message_reads;
pub mod chat_messages;
pub mod chat_reminders;
pub mod chat_sections;
pub mod chat_user_status;
pub mod commerce_portal_access;
pub mod commerce_portal_settings;
pub mod companies;
pub mod connector_connections;
pub mod connector_sync_runs;
pub mod contact_external_identities;
pub mod crm_activities;
pub mod crm_customer_statuses;
pub mod crm_leads;
pub mod crm_opportunities;
pub mod crm_pipeline_stages;
pub mod crm_pipelines;
pub mod crm_quotes;
pub mod crm_transcript_segments;
pub mod crm_transcriptions;
pub mod custom_field_definitions;
pub mod custom_field_values;
pub mod custom_object_links;
pub mod custom_object_records;
pub mod custom_object_relations;
pub mod custom_objects;
pub mod cycle_count_items;
pub mod cycle_counts;
pub mod desk_catalog_items;
pub mod desk_conversations;
pub mod desk_messages;
pub mod desk_phone_agents;
pub mod desk_phone_call_legs;
pub mod desk_phone_routes;
pub mod desk_problems;
pub mod desk_request_approvals;
pub mod desk_sla_clocks;
pub mod desk_visitors;
pub mod desk_voice_agents;
pub mod desk_widget_settings;
pub mod device_tokens;
pub mod discounts;
pub mod dns_records;
pub mod dns_zones;
pub mod doc_versions;
pub mod docs;
pub mod document_versions;
pub mod documents;
pub mod domain_transfers;
pub mod domains;
pub mod drive_shares;
pub mod email_forwards;
pub mod email_templates;
pub mod enrich_field_definitions;
pub mod enrich_field_results;
pub mod enrichment_logs;
pub mod entities;
pub mod entity_number_sequences;
pub mod enums;
pub mod exemption_certificates;
pub mod external_webhooks;
pub mod files;
pub mod fiscal_documents;
pub mod fiscal_periods;
pub mod fixed_asset_books;
pub mod fixed_asset_depreciation;
pub mod fixed_assets;
pub mod flow_approval_delegations;
pub mod flow_approvals;
pub mod flow_member_profiles;
pub mod flow_workspace_settings;
pub mod folders;
pub mod form_1099_filing_lines;
pub mod form_1099_filings;
pub mod form_access;
pub mod form_ai_summaries;
pub mod form_folders;
pub mod form_integrations;
pub mod form_invitations;
pub mod form_response_actions;
pub mod form_response_files;
pub mod form_responses;
pub mod form_settings;
pub mod form_subscriptions;
pub mod form_themes;
pub mod form_versions;
pub mod forms;
pub mod fx_rates;
pub mod github_connections;
pub mod github_issue_sync_map;
pub mod github_project_links;
pub mod github_repo_links;
pub mod grid_views;
pub mod helpcenter_domains;
pub mod helpcenter_settings;
pub mod helpdesk_agents;
pub mod helpdesk_analytics_charts;
pub mod helpdesk_analytics_reports;
pub mod helpdesk_announcements;
pub mod helpdesk_article_folders;
pub mod helpdesk_articles;
pub mod helpdesk_canned_responses;
pub mod helpdesk_changelog;
pub mod helpdesk_channel_integrations;
pub mod helpdesk_conversation_events;
pub mod helpdesk_conversation_messages;
pub mod helpdesk_conversations;
pub mod helpdesk_departments;
pub mod helpdesk_faqs;
pub mod helpdesk_feedback;
pub mod helpdesk_news;
pub mod helpdesk_report_schedules;
pub mod helpdesk_reviews;
pub mod helpdesk_satisfaction_surveys;
pub mod helpdesk_settings;
pub mod helpdesk_slas;
pub mod helpdesk_ticket_messages;
pub mod helpdesk_ticket_notes;
pub mod helpdesk_ticket_types;
pub mod helpdesk_tickets;
pub mod helpdesk_widget_settings;
pub mod helpdesk_workflow_executions;
pub mod helpdesk_workflows;
pub mod hr_absences;
pub mod hr_announcement_reads;
pub mod hr_announcements;
pub mod hr_attendance_records;
pub mod hr_audit_events;
pub mod hr_checklist_tasks;
pub mod hr_checklist_templates;
pub mod hr_checklists;
pub mod hr_client_assignments;
pub mod hr_coaching_logs;
pub mod hr_compensations;
pub mod hr_declarations;
pub mod hr_departments;
pub mod hr_employees;
pub mod hr_evaluation_forms;
pub mod hr_evaluations;
pub mod hr_kpi_definitions;
pub mod hr_kpi_values;
pub mod hr_leave_allowances;
pub mod hr_leave_requests;
pub mod hr_leave_types;
pub mod hr_milestones;
pub mod hr_open_shifts;
pub mod hr_pay_components;
pub mod hr_pay_run_inputs;
pub mod hr_pay_runs;
pub mod hr_pay_schedules;
pub mod hr_payroll_employers;
pub mod hr_payroll_filings;
pub mod hr_payroll_profiles;
pub mod hr_payslips;
pub mod hr_settings;
pub mod hr_shift_requests;
pub mod hr_shifts;
pub mod hr_tax_elections;
pub mod hr_work_locations;
pub mod icp_declarations;
pub mod icp_lines;
pub mod integration_connections;
pub mod integration_entity_mappings;
pub mod integration_field_mappings;
pub mod integration_sync_conflicts;
pub mod inventory;
pub mod inventory_movements;
pub mod invoice_items;
pub mod invoice_templates;
pub mod invoices;
pub mod journal_entries;
pub mod journal_lines;
pub mod knowledge_favorites;
pub mod knowledge_page_versions;
pub mod knowledge_pages;
pub mod knowledge_space_members;
pub mod knowledge_spaces;
pub mod legal_entity_members;
pub mod legal_entity_registrations;
pub mod list_members;
pub mod lists;
pub mod lock_date_exceptions;
pub mod mail_accounts;
pub mod mail_attachments;
pub mod mail_campaigns;
pub mod mail_correspondents;
pub mod mail_domains;
pub mod mail_drafts;
pub mod mail_folders;
pub mod mail_labels;
pub mod mail_messages;
pub mod mail_rules;
pub mod mail_signatures;
pub mod mail_subscriptions;
pub mod mail_suppressions;
pub mod mail_templates;
pub mod meeting_bot_instances;
pub mod meeting_bot_sessions;
pub mod meeting_messages;
pub mod meeting_session_waitlist;
pub mod meeting_sessions;
pub mod meetings;
pub mod member_notes;
pub mod merge_chat_subscriptions;
pub mod merge_comments;
pub mod merge_connections;
pub mod merge_cycles;
pub mod merge_external_issues;
pub mod merge_inbox_states;
pub mod merge_issue_pull_requests;
pub mod merge_issues;
pub mod merge_labels;
pub mod merge_provider_accounts;
pub mod merge_pull_requests;
pub mod merge_record_links;
pub mod merge_release_pull_requests;
pub mod merge_releases;
pub mod merge_repositories;
pub mod merge_teams;
pub mod milestones;
pub mod notification_preferences;
pub mod notifications;
pub mod object_templates;
pub mod order_items;
pub mod orders;
pub mod panel_ai_summaries;
pub mod panel_alert_events;
pub mod panel_alerts;
pub mod panel_annotations;
pub mod panel_cohorts;
pub mod panel_comments;
pub mod panel_computed_properties;
pub mod panel_custom_events;
pub mod panel_dashboard_tiles;
pub mod panel_dashboards;
pub mod panel_erased_ids;
pub mod panel_event_definitions;
pub mod panel_export_runs;
pub mod panel_exports;
pub mod panel_group_slots;
pub mod panel_group_types;
pub mod panel_groups;
pub mod panel_heatmap_pages;
pub mod panel_identity_links;
pub mod panel_metric_trees;
pub mod panel_path_rules;
pub mod panel_people;
pub mod panel_project_meta;
pub mod panel_projects;
pub mod panel_report_versions;
pub mod panel_reports;
pub mod panel_session_favorites;
pub mod panel_share_links;
pub mod panel_subscriptions;
pub mod parcels;
pub mod parties;
pub mod payment_allocations;
pub mod payment_runs;
pub mod payments;
pub mod payroll_connections;
pub mod payroll_imports;
pub mod pending_uploads;
pub mod people;
pub mod person_companies;
pub mod pick_list_items;
pub mod pick_lists;
pub mod pickups;
pub mod product_connections;
pub mod product_sales_channels;
pub mod product_suppliers;
pub mod product_variants;
pub mod products;
pub mod project_baselines;
pub mod project_benefit_measurements;
pub mod project_benefits;
pub mod project_change_requests;
pub mod project_control_links;
pub mod project_decisions;
pub mod project_deliverables;
pub mod project_documents;
pub mod project_files;
pub mod project_finance_snapshots;
pub mod project_goals;
pub mod project_labels;
pub mod project_lessons;
pub mod project_members;
pub mod project_messages;
pub mod project_phases;
pub mod project_pipeline_stages;
pub mod project_raci;
pub mod project_raid_assessments;
pub mod project_raid_items;
pub mod project_requests;
pub mod project_scope;
pub mod project_stakeholders;
pub mod project_status_reports;
pub mod project_templates;
pub mod project_whiteboards;
pub mod projects;
pub mod purchase_order_items;
pub mod purchase_order_receipts;
pub mod purchase_orders;
pub mod reach_campaign_mailboxes;
pub mod reach_campaign_steps;
pub mod reach_campaigns;
pub mod reach_domains;
pub mod reach_enrollments;
pub mod reach_mailboxes;
pub mod reach_messages;
pub mod reach_prospect_list_members;
pub mod reach_prospect_lists;
pub mod reach_prospects;
pub mod reach_settings;
pub mod reach_suppressions;
pub mod received_fiscal_documents;
pub mod reconciliation_rules;
pub mod recurring_invoices;
pub mod resource_bookings;
pub mod resource_requests;
pub mod return_reason_groups;
pub mod return_reasons;
pub mod return_rules;
pub mod returns;
pub mod roles;
pub mod sales_tax_agencies;
pub mod sales_tax_jurisdiction_rates;
pub mod sales_tax_jurisdictions;
pub mod sales_tax_taxability_rules;
pub mod sales_tax_zones;
pub mod search_index;
pub mod sequence_enrollments;
pub mod settings;
pub mod sheet_data_sources;
pub mod sheet_versions;
pub mod sheets;
pub mod shipments;
pub mod shipping_prices;
pub mod shipping_rules;
pub mod sign_documents;
pub mod sign_envelopes;
pub mod sign_events;
pub mod sign_fields;
pub mod sign_recipients;
pub mod sign_settings;
pub mod sms_templates;
pub mod social_accounts;
pub mod social_analytics;
pub mod social_approval_history;
pub mod social_approvals;
pub mod social_campaigns;
pub mod social_media;
pub mod social_posts;
pub mod social_team_members;
pub mod sprints;
pub mod stash_item_plans;
pub mod stash_planning_runs;
pub mod stash_reorder_rules;
pub mod stash_sales_history;
pub mod stash_sales_history_imports;
pub mod stash_settings;
pub mod stock_adjustments;
pub mod suppliers;
pub mod support_channel_members;
pub mod support_channels;
pub mod support_messages;
pub mod sync_logs;
pub mod system_settings;
pub mod task_comments;
pub mod task_dependencies;
pub mod task_digest_settings;
pub mod task_import_jobs;
pub mod task_number_sequences;
pub mod task_projects;
pub mod task_tags;
pub mod tasks;
pub mod tax_calendar_completions;
pub mod tax_id_reveals;
pub mod tax_lines;
pub mod tax_rates;
pub mod tax_returns;
pub mod time_entries;
pub mod tracking_events;
pub mod user_app_assignments;
pub mod user_preferences;
pub mod vat_returns;
pub mod vies_checks;
pub mod views;
pub mod voip_calls;
pub mod voip_phone_numbers;
pub mod voip_porting_orders;
pub mod voip_sip_trunks;
pub mod w9_requests;
pub mod wallet_transactions;
pub mod wallets;
pub mod warehouse_locations;
pub mod warehouse_workers;
pub mod warehouse_zones;
pub mod warehouses;
pub mod webhook_deliveries;
pub mod weldagent_agent_members;
pub mod weldagent_agent_runs;
pub mod weldagent_agent_skills;
pub mod weldagent_agents;
pub mod weldagent_approvals;
pub mod weldagent_conversations;
pub mod weldagent_memories;
pub mod weldagent_messages;
pub mod weldagent_routine_runs;
pub mod weldagent_routines;
pub mod weldagent_skills;
pub mod weldagent_teach_sessions;
pub mod weldagent_templates;
pub mod welddata_cells;
pub mod welddata_columns;
pub mod welddata_leads;
pub mod welddata_lists;
pub mod weldpass_audit_events;
pub mod weldpass_environments;
pub mod weldpass_item_versions;
pub mod weldpass_items;
pub mod weldpass_projects;
pub mod weldpass_provider_credentials;
pub mod weldpass_secret_versions;
pub mod weldpass_secrets;
pub mod weldpass_sync_runs;
pub mod weldpass_sync_targets;
pub mod weldpass_vault_events;
pub mod weldpass_vault_members;
pub mod weldpass_vaults;
pub mod whatsapp_templates;
pub mod whiteboards;
pub mod workflow_error_logs;
pub mod workflow_execution_steps;
pub mod workflow_executions;
pub mod workflow_integrations;
pub mod workflow_schedules;
pub mod workflow_templates;
pub mod workflow_trigger_index;
pub mod workflow_triggers;
pub mod workflow_variables;
pub mod workflow_versions;
pub mod workflow_webhooks;
pub mod workflows;
pub mod workspace_api_keys;
pub mod workspace_installed_apps;
pub mod workspace_members;
pub mod workspace_settings;

/// Every table, from its entity and its DDL, in name order.
pub fn tables() -> Vec<crate::snapshot::TableSchema> {
    vec![
        crate::snapshot::table::<access_requests::Entity>(&access_requests::DDL),
        crate::snapshot::table::<accounting_bank_account_settings::Entity>(
            &accounting_bank_account_settings::DDL,
        ),
        crate::snapshot::table::<accounting_contacts::Entity>(&accounting_contacts::DDL),
        crate::snapshot::table::<accounting_dimension_values::Entity>(
            &accounting_dimension_values::DDL,
        ),
        crate::snapshot::table::<accounting_entity_settings::Entity>(
            &accounting_entity_settings::DDL,
        ),
        crate::snapshot::table::<accounts::Entity>(&accounts::DDL),
        crate::snapshot::table::<active_timers::Entity>(&active_timers::DDL),
        crate::snapshot::table::<activity_logs::Entity>(&activity_logs::DDL),
        crate::snapshot::table::<ad_accounts::Entity>(&ad_accounts::DDL),
        crate::snapshot::table::<ad_campaigns::Entity>(&ad_campaigns::DDL),
        crate::snapshot::table::<ad_platform_connections::Entity>(&ad_platform_connections::DDL),
        crate::snapshot::table::<ai_provider_keys::Entity>(&ai_provider_keys::DDL),
        crate::snapshot::table::<ai_settings::Entity>(&ai_settings::DDL),
        crate::snapshot::table::<analytics_charts::Entity>(&analytics_charts::DDL),
        crate::snapshot::table::<analytics_reports::Entity>(&analytics_reports::DDL),
        crate::snapshot::table::<api_keys::Entity>(&api_keys::DDL),
        crate::snapshot::table::<app_kv::Entity>(&app_kv::DDL),
        crate::snapshot::table::<app_records::Entity>(&app_records::DDL),
        crate::snapshot::table::<asset_sources::Entity>(&asset_sources::DDL),
        crate::snapshot::table::<audit_log::Entity>(&audit_log::DDL),
        crate::snapshot::table::<audit_log_streams::Entity>(&audit_log_streams::DDL),
        crate::snapshot::table::<audit_logs::Entity>(&audit_logs::DDL),
        crate::snapshot::table::<bank_accounts::Entity>(&bank_accounts::DDL),
        crate::snapshot::table::<bank_connections::Entity>(&bank_connections::DDL),
        crate::snapshot::table::<bank_deposits::Entity>(&bank_deposits::DDL),
        crate::snapshot::table::<bank_feed_pending_transactions::Entity>(
            &bank_feed_pending_transactions::DDL,
        ),
        crate::snapshot::table::<bank_import_batches::Entity>(&bank_import_batches::DDL),
        crate::snapshot::table::<bank_reconciliations::Entity>(&bank_reconciliations::DDL),
        crate::snapshot::table::<bank_transactions::Entity>(&bank_transactions::DDL),
        crate::snapshot::table::<bill_items::Entity>(&bill_items::DDL),
        crate::snapshot::table::<bills::Entity>(&bills::DDL),
        crate::snapshot::table::<board_versions::Entity>(&board_versions::DDL),
        crate::snapshot::table::<boxes::Entity>(&boxes::DDL),
        crate::snapshot::table::<calendar_booking_pages::Entity>(&calendar_booking_pages::DDL),
        crate::snapshot::table::<calendar_bookings::Entity>(&calendar_bookings::DDL),
        crate::snapshot::table::<calendar_events::Entity>(&calendar_events::DDL),
        crate::snapshot::table::<calendar_shares::Entity>(&calendar_shares::DDL),
        crate::snapshot::table::<calendars::Entity>(&calendars::DDL),
        crate::snapshot::table::<carrier_services::Entity>(&carrier_services::DDL),
        crate::snapshot::table::<carriers::Entity>(&carriers::DDL),
        crate::snapshot::table::<categories::Entity>(&categories::DDL),
        crate::snapshot::table::<category_products::Entity>(&category_products::DDL),
        crate::snapshot::table::<chat_bookmarks::Entity>(&chat_bookmarks::DDL),
        crate::snapshot::table::<chat_calls::Entity>(&chat_calls::DDL),
        crate::snapshot::table::<chat_channel_members::Entity>(&chat_channel_members::DDL),
        crate::snapshot::table::<chat_channel_role_links::Entity>(&chat_channel_role_links::DDL),
        crate::snapshot::table::<chat_channels::Entity>(&chat_channels::DDL),
        crate::snapshot::table::<chat_drafts::Entity>(&chat_drafts::DDL),
        crate::snapshot::table::<chat_message_reads::Entity>(&chat_message_reads::DDL),
        crate::snapshot::table::<chat_messages::Entity>(&chat_messages::DDL),
        crate::snapshot::table::<chat_reminders::Entity>(&chat_reminders::DDL),
        crate::snapshot::table::<chat_sections::Entity>(&chat_sections::DDL),
        crate::snapshot::table::<chat_user_status::Entity>(&chat_user_status::DDL),
        crate::snapshot::table::<commerce_portal_access::Entity>(&commerce_portal_access::DDL),
        crate::snapshot::table::<commerce_portal_settings::Entity>(&commerce_portal_settings::DDL),
        crate::snapshot::table::<companies::Entity>(&companies::DDL),
        crate::snapshot::table::<connector_connections::Entity>(&connector_connections::DDL),
        crate::snapshot::table::<connector_sync_runs::Entity>(&connector_sync_runs::DDL),
        crate::snapshot::table::<contact_external_identities::Entity>(
            &contact_external_identities::DDL,
        ),
        crate::snapshot::table::<crm_activities::Entity>(&crm_activities::DDL),
        crate::snapshot::table::<crm_customer_statuses::Entity>(&crm_customer_statuses::DDL),
        crate::snapshot::table::<crm_leads::Entity>(&crm_leads::DDL),
        crate::snapshot::table::<crm_opportunities::Entity>(&crm_opportunities::DDL),
        crate::snapshot::table::<crm_pipeline_stages::Entity>(&crm_pipeline_stages::DDL),
        crate::snapshot::table::<crm_pipelines::Entity>(&crm_pipelines::DDL),
        crate::snapshot::table::<crm_quotes::Entity>(&crm_quotes::DDL),
        crate::snapshot::table::<crm_transcript_segments::Entity>(&crm_transcript_segments::DDL),
        crate::snapshot::table::<crm_transcriptions::Entity>(&crm_transcriptions::DDL),
        crate::snapshot::table::<custom_field_definitions::Entity>(&custom_field_definitions::DDL),
        crate::snapshot::table::<custom_field_values::Entity>(&custom_field_values::DDL),
        crate::snapshot::table::<custom_object_links::Entity>(&custom_object_links::DDL),
        crate::snapshot::table::<custom_object_records::Entity>(&custom_object_records::DDL),
        crate::snapshot::table::<custom_object_relations::Entity>(&custom_object_relations::DDL),
        crate::snapshot::table::<custom_objects::Entity>(&custom_objects::DDL),
        crate::snapshot::table::<cycle_count_items::Entity>(&cycle_count_items::DDL),
        crate::snapshot::table::<cycle_counts::Entity>(&cycle_counts::DDL),
        crate::snapshot::table::<desk_catalog_items::Entity>(&desk_catalog_items::DDL),
        crate::snapshot::table::<desk_conversations::Entity>(&desk_conversations::DDL),
        crate::snapshot::table::<desk_messages::Entity>(&desk_messages::DDL),
        crate::snapshot::table::<desk_phone_agents::Entity>(&desk_phone_agents::DDL),
        crate::snapshot::table::<desk_phone_call_legs::Entity>(&desk_phone_call_legs::DDL),
        crate::snapshot::table::<desk_phone_routes::Entity>(&desk_phone_routes::DDL),
        crate::snapshot::table::<desk_problems::Entity>(&desk_problems::DDL),
        crate::snapshot::table::<desk_request_approvals::Entity>(&desk_request_approvals::DDL),
        crate::snapshot::table::<desk_sla_clocks::Entity>(&desk_sla_clocks::DDL),
        crate::snapshot::table::<desk_visitors::Entity>(&desk_visitors::DDL),
        crate::snapshot::table::<desk_voice_agents::Entity>(&desk_voice_agents::DDL),
        crate::snapshot::table::<desk_widget_settings::Entity>(&desk_widget_settings::DDL),
        crate::snapshot::table::<device_tokens::Entity>(&device_tokens::DDL),
        crate::snapshot::table::<discounts::Entity>(&discounts::DDL),
        crate::snapshot::table::<dns_records::Entity>(&dns_records::DDL),
        crate::snapshot::table::<dns_zones::Entity>(&dns_zones::DDL),
        crate::snapshot::table::<doc_versions::Entity>(&doc_versions::DDL),
        crate::snapshot::table::<docs::Entity>(&docs::DDL),
        crate::snapshot::table::<document_versions::Entity>(&document_versions::DDL),
        crate::snapshot::table::<documents::Entity>(&documents::DDL),
        crate::snapshot::table::<domain_transfers::Entity>(&domain_transfers::DDL),
        crate::snapshot::table::<domains::Entity>(&domains::DDL),
        crate::snapshot::table::<drive_shares::Entity>(&drive_shares::DDL),
        crate::snapshot::table::<email_forwards::Entity>(&email_forwards::DDL),
        crate::snapshot::table::<email_templates::Entity>(&email_templates::DDL),
        crate::snapshot::table::<enrich_field_definitions::Entity>(&enrich_field_definitions::DDL),
        crate::snapshot::table::<enrich_field_results::Entity>(&enrich_field_results::DDL),
        crate::snapshot::table::<enrichment_logs::Entity>(&enrichment_logs::DDL),
        crate::snapshot::table::<entities::Entity>(&entities::DDL),
        crate::snapshot::table::<entity_number_sequences::Entity>(&entity_number_sequences::DDL),
        crate::snapshot::table::<exemption_certificates::Entity>(&exemption_certificates::DDL),
        crate::snapshot::table::<external_webhooks::Entity>(&external_webhooks::DDL),
        crate::snapshot::table::<files::Entity>(&files::DDL),
        crate::snapshot::table::<fiscal_documents::Entity>(&fiscal_documents::DDL),
        crate::snapshot::table::<fiscal_periods::Entity>(&fiscal_periods::DDL),
        crate::snapshot::table::<fixed_asset_books::Entity>(&fixed_asset_books::DDL),
        crate::snapshot::table::<fixed_asset_depreciation::Entity>(&fixed_asset_depreciation::DDL),
        crate::snapshot::table::<fixed_assets::Entity>(&fixed_assets::DDL),
        crate::snapshot::table::<flow_approval_delegations::Entity>(
            &flow_approval_delegations::DDL,
        ),
        crate::snapshot::table::<flow_approvals::Entity>(&flow_approvals::DDL),
        crate::snapshot::table::<flow_member_profiles::Entity>(&flow_member_profiles::DDL),
        crate::snapshot::table::<flow_workspace_settings::Entity>(&flow_workspace_settings::DDL),
        crate::snapshot::table::<folders::Entity>(&folders::DDL),
        crate::snapshot::table::<form_1099_filing_lines::Entity>(&form_1099_filing_lines::DDL),
        crate::snapshot::table::<form_1099_filings::Entity>(&form_1099_filings::DDL),
        crate::snapshot::table::<form_access::Entity>(&form_access::DDL),
        crate::snapshot::table::<form_ai_summaries::Entity>(&form_ai_summaries::DDL),
        crate::snapshot::table::<form_folders::Entity>(&form_folders::DDL),
        crate::snapshot::table::<form_integrations::Entity>(&form_integrations::DDL),
        crate::snapshot::table::<form_invitations::Entity>(&form_invitations::DDL),
        crate::snapshot::table::<form_response_actions::Entity>(&form_response_actions::DDL),
        crate::snapshot::table::<form_response_files::Entity>(&form_response_files::DDL),
        crate::snapshot::table::<form_responses::Entity>(&form_responses::DDL),
        crate::snapshot::table::<form_settings::Entity>(&form_settings::DDL),
        crate::snapshot::table::<form_subscriptions::Entity>(&form_subscriptions::DDL),
        crate::snapshot::table::<form_themes::Entity>(&form_themes::DDL),
        crate::snapshot::table::<form_versions::Entity>(&form_versions::DDL),
        crate::snapshot::table::<forms::Entity>(&forms::DDL),
        crate::snapshot::table::<fx_rates::Entity>(&fx_rates::DDL),
        crate::snapshot::table::<github_connections::Entity>(&github_connections::DDL),
        crate::snapshot::table::<github_issue_sync_map::Entity>(&github_issue_sync_map::DDL),
        crate::snapshot::table::<github_project_links::Entity>(&github_project_links::DDL),
        crate::snapshot::table::<github_repo_links::Entity>(&github_repo_links::DDL),
        crate::snapshot::table::<grid_views::Entity>(&grid_views::DDL),
        crate::snapshot::table::<helpcenter_domains::Entity>(&helpcenter_domains::DDL),
        crate::snapshot::table::<helpcenter_settings::Entity>(&helpcenter_settings::DDL),
        crate::snapshot::table::<helpdesk_agents::Entity>(&helpdesk_agents::DDL),
        crate::snapshot::table::<helpdesk_analytics_charts::Entity>(
            &helpdesk_analytics_charts::DDL,
        ),
        crate::snapshot::table::<helpdesk_analytics_reports::Entity>(
            &helpdesk_analytics_reports::DDL,
        ),
        crate::snapshot::table::<helpdesk_announcements::Entity>(&helpdesk_announcements::DDL),
        crate::snapshot::table::<helpdesk_article_folders::Entity>(&helpdesk_article_folders::DDL),
        crate::snapshot::table::<helpdesk_articles::Entity>(&helpdesk_articles::DDL),
        crate::snapshot::table::<helpdesk_canned_responses::Entity>(
            &helpdesk_canned_responses::DDL,
        ),
        crate::snapshot::table::<helpdesk_changelog::Entity>(&helpdesk_changelog::DDL),
        crate::snapshot::table::<helpdesk_channel_integrations::Entity>(
            &helpdesk_channel_integrations::DDL,
        ),
        crate::snapshot::table::<helpdesk_conversation_events::Entity>(
            &helpdesk_conversation_events::DDL,
        ),
        crate::snapshot::table::<helpdesk_conversation_messages::Entity>(
            &helpdesk_conversation_messages::DDL,
        ),
        crate::snapshot::table::<helpdesk_conversations::Entity>(&helpdesk_conversations::DDL),
        crate::snapshot::table::<helpdesk_departments::Entity>(&helpdesk_departments::DDL),
        crate::snapshot::table::<helpdesk_faqs::Entity>(&helpdesk_faqs::DDL),
        crate::snapshot::table::<helpdesk_feedback::Entity>(&helpdesk_feedback::DDL),
        crate::snapshot::table::<helpdesk_news::Entity>(&helpdesk_news::DDL),
        crate::snapshot::table::<helpdesk_report_schedules::Entity>(
            &helpdesk_report_schedules::DDL,
        ),
        crate::snapshot::table::<helpdesk_reviews::Entity>(&helpdesk_reviews::DDL),
        crate::snapshot::table::<helpdesk_satisfaction_surveys::Entity>(
            &helpdesk_satisfaction_surveys::DDL,
        ),
        crate::snapshot::table::<helpdesk_settings::Entity>(&helpdesk_settings::DDL),
        crate::snapshot::table::<helpdesk_slas::Entity>(&helpdesk_slas::DDL),
        crate::snapshot::table::<helpdesk_ticket_messages::Entity>(&helpdesk_ticket_messages::DDL),
        crate::snapshot::table::<helpdesk_ticket_notes::Entity>(&helpdesk_ticket_notes::DDL),
        crate::snapshot::table::<helpdesk_ticket_types::Entity>(&helpdesk_ticket_types::DDL),
        crate::snapshot::table::<helpdesk_tickets::Entity>(&helpdesk_tickets::DDL),
        crate::snapshot::table::<helpdesk_widget_settings::Entity>(&helpdesk_widget_settings::DDL),
        crate::snapshot::table::<helpdesk_workflow_executions::Entity>(
            &helpdesk_workflow_executions::DDL,
        ),
        crate::snapshot::table::<helpdesk_workflows::Entity>(&helpdesk_workflows::DDL),
        crate::snapshot::table::<hr_absences::Entity>(&hr_absences::DDL),
        crate::snapshot::table::<hr_announcement_reads::Entity>(&hr_announcement_reads::DDL),
        crate::snapshot::table::<hr_announcements::Entity>(&hr_announcements::DDL),
        crate::snapshot::table::<hr_attendance_records::Entity>(&hr_attendance_records::DDL),
        crate::snapshot::table::<hr_audit_events::Entity>(&hr_audit_events::DDL),
        crate::snapshot::table::<hr_checklist_tasks::Entity>(&hr_checklist_tasks::DDL),
        crate::snapshot::table::<hr_checklist_templates::Entity>(&hr_checklist_templates::DDL),
        crate::snapshot::table::<hr_checklists::Entity>(&hr_checklists::DDL),
        crate::snapshot::table::<hr_client_assignments::Entity>(&hr_client_assignments::DDL),
        crate::snapshot::table::<hr_coaching_logs::Entity>(&hr_coaching_logs::DDL),
        crate::snapshot::table::<hr_compensations::Entity>(&hr_compensations::DDL),
        crate::snapshot::table::<hr_declarations::Entity>(&hr_declarations::DDL),
        crate::snapshot::table::<hr_departments::Entity>(&hr_departments::DDL),
        crate::snapshot::table::<hr_employees::Entity>(&hr_employees::DDL),
        crate::snapshot::table::<hr_evaluation_forms::Entity>(&hr_evaluation_forms::DDL),
        crate::snapshot::table::<hr_evaluations::Entity>(&hr_evaluations::DDL),
        crate::snapshot::table::<hr_kpi_definitions::Entity>(&hr_kpi_definitions::DDL),
        crate::snapshot::table::<hr_kpi_values::Entity>(&hr_kpi_values::DDL),
        crate::snapshot::table::<hr_leave_allowances::Entity>(&hr_leave_allowances::DDL),
        crate::snapshot::table::<hr_leave_requests::Entity>(&hr_leave_requests::DDL),
        crate::snapshot::table::<hr_leave_types::Entity>(&hr_leave_types::DDL),
        crate::snapshot::table::<hr_milestones::Entity>(&hr_milestones::DDL),
        crate::snapshot::table::<hr_open_shifts::Entity>(&hr_open_shifts::DDL),
        crate::snapshot::table::<hr_pay_components::Entity>(&hr_pay_components::DDL),
        crate::snapshot::table::<hr_pay_run_inputs::Entity>(&hr_pay_run_inputs::DDL),
        crate::snapshot::table::<hr_pay_runs::Entity>(&hr_pay_runs::DDL),
        crate::snapshot::table::<hr_pay_schedules::Entity>(&hr_pay_schedules::DDL),
        crate::snapshot::table::<hr_payroll_employers::Entity>(&hr_payroll_employers::DDL),
        crate::snapshot::table::<hr_payroll_filings::Entity>(&hr_payroll_filings::DDL),
        crate::snapshot::table::<hr_payroll_profiles::Entity>(&hr_payroll_profiles::DDL),
        crate::snapshot::table::<hr_payslips::Entity>(&hr_payslips::DDL),
        crate::snapshot::table::<hr_settings::Entity>(&hr_settings::DDL),
        crate::snapshot::table::<hr_shift_requests::Entity>(&hr_shift_requests::DDL),
        crate::snapshot::table::<hr_shifts::Entity>(&hr_shifts::DDL),
        crate::snapshot::table::<hr_tax_elections::Entity>(&hr_tax_elections::DDL),
        crate::snapshot::table::<hr_work_locations::Entity>(&hr_work_locations::DDL),
        crate::snapshot::table::<icp_declarations::Entity>(&icp_declarations::DDL),
        crate::snapshot::table::<icp_lines::Entity>(&icp_lines::DDL),
        crate::snapshot::table::<integration_connections::Entity>(&integration_connections::DDL),
        crate::snapshot::table::<integration_entity_mappings::Entity>(
            &integration_entity_mappings::DDL,
        ),
        crate::snapshot::table::<integration_field_mappings::Entity>(
            &integration_field_mappings::DDL,
        ),
        crate::snapshot::table::<integration_sync_conflicts::Entity>(
            &integration_sync_conflicts::DDL,
        ),
        crate::snapshot::table::<inventory::Entity>(&inventory::DDL),
        crate::snapshot::table::<inventory_movements::Entity>(&inventory_movements::DDL),
        crate::snapshot::table::<invoice_items::Entity>(&invoice_items::DDL),
        crate::snapshot::table::<invoice_templates::Entity>(&invoice_templates::DDL),
        crate::snapshot::table::<invoices::Entity>(&invoices::DDL),
        crate::snapshot::table::<journal_entries::Entity>(&journal_entries::DDL),
        crate::snapshot::table::<journal_lines::Entity>(&journal_lines::DDL),
        crate::snapshot::table::<knowledge_favorites::Entity>(&knowledge_favorites::DDL),
        crate::snapshot::table::<knowledge_page_versions::Entity>(&knowledge_page_versions::DDL),
        crate::snapshot::table::<knowledge_pages::Entity>(&knowledge_pages::DDL),
        crate::snapshot::table::<knowledge_space_members::Entity>(&knowledge_space_members::DDL),
        crate::snapshot::table::<knowledge_spaces::Entity>(&knowledge_spaces::DDL),
        crate::snapshot::table::<legal_entity_members::Entity>(&legal_entity_members::DDL),
        crate::snapshot::table::<legal_entity_registrations::Entity>(
            &legal_entity_registrations::DDL,
        ),
        crate::snapshot::table::<list_members::Entity>(&list_members::DDL),
        crate::snapshot::table::<lists::Entity>(&lists::DDL),
        crate::snapshot::table::<lock_date_exceptions::Entity>(&lock_date_exceptions::DDL),
        crate::snapshot::table::<mail_accounts::Entity>(&mail_accounts::DDL),
        crate::snapshot::table::<mail_attachments::Entity>(&mail_attachments::DDL),
        crate::snapshot::table::<mail_campaigns::Entity>(&mail_campaigns::DDL),
        crate::snapshot::table::<mail_correspondents::Entity>(&mail_correspondents::DDL),
        crate::snapshot::table::<mail_domains::Entity>(&mail_domains::DDL),
        crate::snapshot::table::<mail_drafts::Entity>(&mail_drafts::DDL),
        crate::snapshot::table::<mail_folders::Entity>(&mail_folders::DDL),
        crate::snapshot::table::<mail_labels::Entity>(&mail_labels::DDL),
        crate::snapshot::table::<mail_messages::Entity>(&mail_messages::DDL),
        crate::snapshot::table::<mail_rules::Entity>(&mail_rules::DDL),
        crate::snapshot::table::<mail_signatures::Entity>(&mail_signatures::DDL),
        crate::snapshot::table::<mail_subscriptions::Entity>(&mail_subscriptions::DDL),
        crate::snapshot::table::<mail_suppressions::Entity>(&mail_suppressions::DDL),
        crate::snapshot::table::<mail_templates::Entity>(&mail_templates::DDL),
        crate::snapshot::table::<meeting_bot_instances::Entity>(&meeting_bot_instances::DDL),
        crate::snapshot::table::<meeting_bot_sessions::Entity>(&meeting_bot_sessions::DDL),
        crate::snapshot::table::<meeting_messages::Entity>(&meeting_messages::DDL),
        crate::snapshot::table::<meeting_session_waitlist::Entity>(&meeting_session_waitlist::DDL),
        crate::snapshot::table::<meeting_sessions::Entity>(&meeting_sessions::DDL),
        crate::snapshot::table::<meetings::Entity>(&meetings::DDL),
        crate::snapshot::table::<member_notes::Entity>(&member_notes::DDL),
        crate::snapshot::table::<merge_chat_subscriptions::Entity>(&merge_chat_subscriptions::DDL),
        crate::snapshot::table::<merge_comments::Entity>(&merge_comments::DDL),
        crate::snapshot::table::<merge_connections::Entity>(&merge_connections::DDL),
        crate::snapshot::table::<merge_cycles::Entity>(&merge_cycles::DDL),
        crate::snapshot::table::<merge_external_issues::Entity>(&merge_external_issues::DDL),
        crate::snapshot::table::<merge_inbox_states::Entity>(&merge_inbox_states::DDL),
        crate::snapshot::table::<merge_issue_pull_requests::Entity>(
            &merge_issue_pull_requests::DDL,
        ),
        crate::snapshot::table::<merge_issues::Entity>(&merge_issues::DDL),
        crate::snapshot::table::<merge_labels::Entity>(&merge_labels::DDL),
        crate::snapshot::table::<merge_provider_accounts::Entity>(&merge_provider_accounts::DDL),
        crate::snapshot::table::<merge_pull_requests::Entity>(&merge_pull_requests::DDL),
        crate::snapshot::table::<merge_record_links::Entity>(&merge_record_links::DDL),
        crate::snapshot::table::<merge_release_pull_requests::Entity>(
            &merge_release_pull_requests::DDL,
        ),
        crate::snapshot::table::<merge_releases::Entity>(&merge_releases::DDL),
        crate::snapshot::table::<merge_repositories::Entity>(&merge_repositories::DDL),
        crate::snapshot::table::<merge_teams::Entity>(&merge_teams::DDL),
        crate::snapshot::table::<milestones::Entity>(&milestones::DDL),
        crate::snapshot::table::<notification_preferences::Entity>(&notification_preferences::DDL),
        crate::snapshot::table::<notifications::Entity>(&notifications::DDL),
        crate::snapshot::table::<object_templates::Entity>(&object_templates::DDL),
        crate::snapshot::table::<order_items::Entity>(&order_items::DDL),
        crate::snapshot::table::<orders::Entity>(&orders::DDL),
        crate::snapshot::table::<panel_ai_summaries::Entity>(&panel_ai_summaries::DDL),
        crate::snapshot::table::<panel_alert_events::Entity>(&panel_alert_events::DDL),
        crate::snapshot::table::<panel_alerts::Entity>(&panel_alerts::DDL),
        crate::snapshot::table::<panel_annotations::Entity>(&panel_annotations::DDL),
        crate::snapshot::table::<panel_cohorts::Entity>(&panel_cohorts::DDL),
        crate::snapshot::table::<panel_comments::Entity>(&panel_comments::DDL),
        crate::snapshot::table::<panel_computed_properties::Entity>(
            &panel_computed_properties::DDL,
        ),
        crate::snapshot::table::<panel_custom_events::Entity>(&panel_custom_events::DDL),
        crate::snapshot::table::<panel_dashboard_tiles::Entity>(&panel_dashboard_tiles::DDL),
        crate::snapshot::table::<panel_dashboards::Entity>(&panel_dashboards::DDL),
        crate::snapshot::table::<panel_erased_ids::Entity>(&panel_erased_ids::DDL),
        crate::snapshot::table::<panel_event_definitions::Entity>(&panel_event_definitions::DDL),
        crate::snapshot::table::<panel_export_runs::Entity>(&panel_export_runs::DDL),
        crate::snapshot::table::<panel_exports::Entity>(&panel_exports::DDL),
        crate::snapshot::table::<panel_group_slots::Entity>(&panel_group_slots::DDL),
        crate::snapshot::table::<panel_group_types::Entity>(&panel_group_types::DDL),
        crate::snapshot::table::<panel_groups::Entity>(&panel_groups::DDL),
        crate::snapshot::table::<panel_heatmap_pages::Entity>(&panel_heatmap_pages::DDL),
        crate::snapshot::table::<panel_identity_links::Entity>(&panel_identity_links::DDL),
        crate::snapshot::table::<panel_metric_trees::Entity>(&panel_metric_trees::DDL),
        crate::snapshot::table::<panel_path_rules::Entity>(&panel_path_rules::DDL),
        crate::snapshot::table::<panel_people::Entity>(&panel_people::DDL),
        crate::snapshot::table::<panel_project_meta::Entity>(&panel_project_meta::DDL),
        crate::snapshot::table::<panel_projects::Entity>(&panel_projects::DDL),
        crate::snapshot::table::<panel_report_versions::Entity>(&panel_report_versions::DDL),
        crate::snapshot::table::<panel_reports::Entity>(&panel_reports::DDL),
        crate::snapshot::table::<panel_session_favorites::Entity>(&panel_session_favorites::DDL),
        crate::snapshot::table::<panel_share_links::Entity>(&panel_share_links::DDL),
        crate::snapshot::table::<panel_subscriptions::Entity>(&panel_subscriptions::DDL),
        crate::snapshot::table::<parcels::Entity>(&parcels::DDL),
        crate::snapshot::table::<parties::Entity>(&parties::DDL),
        crate::snapshot::table::<payment_allocations::Entity>(&payment_allocations::DDL),
        crate::snapshot::table::<payment_runs::Entity>(&payment_runs::DDL),
        crate::snapshot::table::<payments::Entity>(&payments::DDL),
        crate::snapshot::table::<payroll_connections::Entity>(&payroll_connections::DDL),
        crate::snapshot::table::<payroll_imports::Entity>(&payroll_imports::DDL),
        crate::snapshot::table::<pending_uploads::Entity>(&pending_uploads::DDL),
        crate::snapshot::table::<people::Entity>(&people::DDL),
        crate::snapshot::table::<person_companies::Entity>(&person_companies::DDL),
        crate::snapshot::table::<pick_list_items::Entity>(&pick_list_items::DDL),
        crate::snapshot::table::<pick_lists::Entity>(&pick_lists::DDL),
        crate::snapshot::table::<pickups::Entity>(&pickups::DDL),
        crate::snapshot::table::<product_connections::Entity>(&product_connections::DDL),
        crate::snapshot::table::<product_sales_channels::Entity>(&product_sales_channels::DDL),
        crate::snapshot::table::<product_suppliers::Entity>(&product_suppliers::DDL),
        crate::snapshot::table::<product_variants::Entity>(&product_variants::DDL),
        crate::snapshot::table::<products::Entity>(&products::DDL),
        crate::snapshot::table::<project_baselines::Entity>(&project_baselines::DDL),
        crate::snapshot::table::<project_benefit_measurements::Entity>(
            &project_benefit_measurements::DDL,
        ),
        crate::snapshot::table::<project_benefits::Entity>(&project_benefits::DDL),
        crate::snapshot::table::<project_change_requests::Entity>(&project_change_requests::DDL),
        crate::snapshot::table::<project_control_links::Entity>(&project_control_links::DDL),
        crate::snapshot::table::<project_decisions::Entity>(&project_decisions::DDL),
        crate::snapshot::table::<project_deliverables::Entity>(&project_deliverables::DDL),
        crate::snapshot::table::<project_documents::Entity>(&project_documents::DDL),
        crate::snapshot::table::<project_files::Entity>(&project_files::DDL),
        crate::snapshot::table::<project_finance_snapshots::Entity>(
            &project_finance_snapshots::DDL,
        ),
        crate::snapshot::table::<project_goals::Entity>(&project_goals::DDL),
        crate::snapshot::table::<project_labels::Entity>(&project_labels::DDL),
        crate::snapshot::table::<project_lessons::Entity>(&project_lessons::DDL),
        crate::snapshot::table::<project_members::Entity>(&project_members::DDL),
        crate::snapshot::table::<project_messages::Entity>(&project_messages::DDL),
        crate::snapshot::table::<project_phases::Entity>(&project_phases::DDL),
        crate::snapshot::table::<project_pipeline_stages::Entity>(&project_pipeline_stages::DDL),
        crate::snapshot::table::<project_raci::Entity>(&project_raci::DDL),
        crate::snapshot::table::<project_raid_assessments::Entity>(&project_raid_assessments::DDL),
        crate::snapshot::table::<project_raid_items::Entity>(&project_raid_items::DDL),
        crate::snapshot::table::<project_requests::Entity>(&project_requests::DDL),
        crate::snapshot::table::<project_scope::Entity>(&project_scope::DDL),
        crate::snapshot::table::<project_stakeholders::Entity>(&project_stakeholders::DDL),
        crate::snapshot::table::<project_status_reports::Entity>(&project_status_reports::DDL),
        crate::snapshot::table::<project_templates::Entity>(&project_templates::DDL),
        crate::snapshot::table::<project_whiteboards::Entity>(&project_whiteboards::DDL),
        crate::snapshot::table::<projects::Entity>(&projects::DDL),
        crate::snapshot::table::<purchase_order_items::Entity>(&purchase_order_items::DDL),
        crate::snapshot::table::<purchase_order_receipts::Entity>(&purchase_order_receipts::DDL),
        crate::snapshot::table::<purchase_orders::Entity>(&purchase_orders::DDL),
        crate::snapshot::table::<reach_campaign_mailboxes::Entity>(&reach_campaign_mailboxes::DDL),
        crate::snapshot::table::<reach_campaign_steps::Entity>(&reach_campaign_steps::DDL),
        crate::snapshot::table::<reach_campaigns::Entity>(&reach_campaigns::DDL),
        crate::snapshot::table::<reach_domains::Entity>(&reach_domains::DDL),
        crate::snapshot::table::<reach_enrollments::Entity>(&reach_enrollments::DDL),
        crate::snapshot::table::<reach_mailboxes::Entity>(&reach_mailboxes::DDL),
        crate::snapshot::table::<reach_messages::Entity>(&reach_messages::DDL),
        crate::snapshot::table::<reach_prospect_list_members::Entity>(
            &reach_prospect_list_members::DDL,
        ),
        crate::snapshot::table::<reach_prospect_lists::Entity>(&reach_prospect_lists::DDL),
        crate::snapshot::table::<reach_prospects::Entity>(&reach_prospects::DDL),
        crate::snapshot::table::<reach_settings::Entity>(&reach_settings::DDL),
        crate::snapshot::table::<reach_suppressions::Entity>(&reach_suppressions::DDL),
        crate::snapshot::table::<received_fiscal_documents::Entity>(
            &received_fiscal_documents::DDL,
        ),
        crate::snapshot::table::<reconciliation_rules::Entity>(&reconciliation_rules::DDL),
        crate::snapshot::table::<recurring_invoices::Entity>(&recurring_invoices::DDL),
        crate::snapshot::table::<resource_bookings::Entity>(&resource_bookings::DDL),
        crate::snapshot::table::<resource_requests::Entity>(&resource_requests::DDL),
        crate::snapshot::table::<return_reason_groups::Entity>(&return_reason_groups::DDL),
        crate::snapshot::table::<return_reasons::Entity>(&return_reasons::DDL),
        crate::snapshot::table::<return_rules::Entity>(&return_rules::DDL),
        crate::snapshot::table::<returns::Entity>(&returns::DDL),
        crate::snapshot::table::<roles::Entity>(&roles::DDL),
        crate::snapshot::table::<sales_tax_agencies::Entity>(&sales_tax_agencies::DDL),
        crate::snapshot::table::<sales_tax_jurisdiction_rates::Entity>(
            &sales_tax_jurisdiction_rates::DDL,
        ),
        crate::snapshot::table::<sales_tax_jurisdictions::Entity>(&sales_tax_jurisdictions::DDL),
        crate::snapshot::table::<sales_tax_taxability_rules::Entity>(
            &sales_tax_taxability_rules::DDL,
        ),
        crate::snapshot::table::<sales_tax_zones::Entity>(&sales_tax_zones::DDL),
        crate::snapshot::table::<search_index::Entity>(&search_index::DDL),
        crate::snapshot::table::<sequence_enrollments::Entity>(&sequence_enrollments::DDL),
        crate::snapshot::table::<settings::Entity>(&settings::DDL),
        crate::snapshot::table::<sheet_data_sources::Entity>(&sheet_data_sources::DDL),
        crate::snapshot::table::<sheet_versions::Entity>(&sheet_versions::DDL),
        crate::snapshot::table::<sheets::Entity>(&sheets::DDL),
        crate::snapshot::table::<shipments::Entity>(&shipments::DDL),
        crate::snapshot::table::<shipping_prices::Entity>(&shipping_prices::DDL),
        crate::snapshot::table::<shipping_rules::Entity>(&shipping_rules::DDL),
        crate::snapshot::table::<sign_documents::Entity>(&sign_documents::DDL),
        crate::snapshot::table::<sign_envelopes::Entity>(&sign_envelopes::DDL),
        crate::snapshot::table::<sign_events::Entity>(&sign_events::DDL),
        crate::snapshot::table::<sign_fields::Entity>(&sign_fields::DDL),
        crate::snapshot::table::<sign_recipients::Entity>(&sign_recipients::DDL),
        crate::snapshot::table::<sign_settings::Entity>(&sign_settings::DDL),
        crate::snapshot::table::<sms_templates::Entity>(&sms_templates::DDL),
        crate::snapshot::table::<social_accounts::Entity>(&social_accounts::DDL),
        crate::snapshot::table::<social_analytics::Entity>(&social_analytics::DDL),
        crate::snapshot::table::<social_approval_history::Entity>(&social_approval_history::DDL),
        crate::snapshot::table::<social_approvals::Entity>(&social_approvals::DDL),
        crate::snapshot::table::<social_campaigns::Entity>(&social_campaigns::DDL),
        crate::snapshot::table::<social_media::Entity>(&social_media::DDL),
        crate::snapshot::table::<social_posts::Entity>(&social_posts::DDL),
        crate::snapshot::table::<social_team_members::Entity>(&social_team_members::DDL),
        crate::snapshot::table::<sprints::Entity>(&sprints::DDL),
        crate::snapshot::table::<stash_item_plans::Entity>(&stash_item_plans::DDL),
        crate::snapshot::table::<stash_planning_runs::Entity>(&stash_planning_runs::DDL),
        crate::snapshot::table::<stash_reorder_rules::Entity>(&stash_reorder_rules::DDL),
        crate::snapshot::table::<stash_sales_history::Entity>(&stash_sales_history::DDL),
        crate::snapshot::table::<stash_sales_history_imports::Entity>(
            &stash_sales_history_imports::DDL,
        ),
        crate::snapshot::table::<stash_settings::Entity>(&stash_settings::DDL),
        crate::snapshot::table::<stock_adjustments::Entity>(&stock_adjustments::DDL),
        crate::snapshot::table::<suppliers::Entity>(&suppliers::DDL),
        crate::snapshot::table::<support_channel_members::Entity>(&support_channel_members::DDL),
        crate::snapshot::table::<support_channels::Entity>(&support_channels::DDL),
        crate::snapshot::table::<support_messages::Entity>(&support_messages::DDL),
        crate::snapshot::table::<sync_logs::Entity>(&sync_logs::DDL),
        crate::snapshot::table::<system_settings::Entity>(&system_settings::DDL),
        crate::snapshot::table::<task_comments::Entity>(&task_comments::DDL),
        crate::snapshot::table::<task_dependencies::Entity>(&task_dependencies::DDL),
        crate::snapshot::table::<task_digest_settings::Entity>(&task_digest_settings::DDL),
        crate::snapshot::table::<task_import_jobs::Entity>(&task_import_jobs::DDL),
        crate::snapshot::table::<task_number_sequences::Entity>(&task_number_sequences::DDL),
        crate::snapshot::table::<task_projects::Entity>(&task_projects::DDL),
        crate::snapshot::table::<task_tags::Entity>(&task_tags::DDL),
        crate::snapshot::table::<tasks::Entity>(&tasks::DDL),
        crate::snapshot::table::<tax_calendar_completions::Entity>(&tax_calendar_completions::DDL),
        crate::snapshot::table::<tax_id_reveals::Entity>(&tax_id_reveals::DDL),
        crate::snapshot::table::<tax_lines::Entity>(&tax_lines::DDL),
        crate::snapshot::table::<tax_rates::Entity>(&tax_rates::DDL),
        crate::snapshot::table::<tax_returns::Entity>(&tax_returns::DDL),
        crate::snapshot::table::<time_entries::Entity>(&time_entries::DDL),
        crate::snapshot::table::<tracking_events::Entity>(&tracking_events::DDL),
        crate::snapshot::table::<user_app_assignments::Entity>(&user_app_assignments::DDL),
        crate::snapshot::table::<user_preferences::Entity>(&user_preferences::DDL),
        crate::snapshot::table::<vat_returns::Entity>(&vat_returns::DDL),
        crate::snapshot::table::<vies_checks::Entity>(&vies_checks::DDL),
        crate::snapshot::table::<voip_calls::Entity>(&voip_calls::DDL),
        crate::snapshot::table::<voip_phone_numbers::Entity>(&voip_phone_numbers::DDL),
        crate::snapshot::table::<voip_porting_orders::Entity>(&voip_porting_orders::DDL),
        crate::snapshot::table::<voip_sip_trunks::Entity>(&voip_sip_trunks::DDL),
        crate::snapshot::table::<w9_requests::Entity>(&w9_requests::DDL),
        crate::snapshot::table::<wallet_transactions::Entity>(&wallet_transactions::DDL),
        crate::snapshot::table::<wallets::Entity>(&wallets::DDL),
        crate::snapshot::table::<warehouse_locations::Entity>(&warehouse_locations::DDL),
        crate::snapshot::table::<warehouse_workers::Entity>(&warehouse_workers::DDL),
        crate::snapshot::table::<warehouse_zones::Entity>(&warehouse_zones::DDL),
        crate::snapshot::table::<warehouses::Entity>(&warehouses::DDL),
        crate::snapshot::table::<webhook_deliveries::Entity>(&webhook_deliveries::DDL),
        crate::snapshot::table::<weldagent_agent_members::Entity>(&weldagent_agent_members::DDL),
        crate::snapshot::table::<weldagent_agent_runs::Entity>(&weldagent_agent_runs::DDL),
        crate::snapshot::table::<weldagent_agent_skills::Entity>(&weldagent_agent_skills::DDL),
        crate::snapshot::table::<weldagent_agents::Entity>(&weldagent_agents::DDL),
        crate::snapshot::table::<weldagent_approvals::Entity>(&weldagent_approvals::DDL),
        crate::snapshot::table::<weldagent_conversations::Entity>(&weldagent_conversations::DDL),
        crate::snapshot::table::<weldagent_memories::Entity>(&weldagent_memories::DDL),
        crate::snapshot::table::<weldagent_messages::Entity>(&weldagent_messages::DDL),
        crate::snapshot::table::<weldagent_routine_runs::Entity>(&weldagent_routine_runs::DDL),
        crate::snapshot::table::<weldagent_routines::Entity>(&weldagent_routines::DDL),
        crate::snapshot::table::<weldagent_skills::Entity>(&weldagent_skills::DDL),
        crate::snapshot::table::<weldagent_teach_sessions::Entity>(&weldagent_teach_sessions::DDL),
        crate::snapshot::table::<weldagent_templates::Entity>(&weldagent_templates::DDL),
        crate::snapshot::table::<welddata_cells::Entity>(&welddata_cells::DDL),
        crate::snapshot::table::<welddata_columns::Entity>(&welddata_columns::DDL),
        crate::snapshot::table::<welddata_leads::Entity>(&welddata_leads::DDL),
        crate::snapshot::table::<welddata_lists::Entity>(&welddata_lists::DDL),
        crate::snapshot::table::<weldpass_audit_events::Entity>(&weldpass_audit_events::DDL),
        crate::snapshot::table::<weldpass_environments::Entity>(&weldpass_environments::DDL),
        crate::snapshot::table::<weldpass_item_versions::Entity>(&weldpass_item_versions::DDL),
        crate::snapshot::table::<weldpass_items::Entity>(&weldpass_items::DDL),
        crate::snapshot::table::<weldpass_projects::Entity>(&weldpass_projects::DDL),
        crate::snapshot::table::<weldpass_provider_credentials::Entity>(
            &weldpass_provider_credentials::DDL,
        ),
        crate::snapshot::table::<weldpass_secret_versions::Entity>(&weldpass_secret_versions::DDL),
        crate::snapshot::table::<weldpass_secrets::Entity>(&weldpass_secrets::DDL),
        crate::snapshot::table::<weldpass_sync_runs::Entity>(&weldpass_sync_runs::DDL),
        crate::snapshot::table::<weldpass_sync_targets::Entity>(&weldpass_sync_targets::DDL),
        crate::snapshot::table::<weldpass_vault_events::Entity>(&weldpass_vault_events::DDL),
        crate::snapshot::table::<weldpass_vault_members::Entity>(&weldpass_vault_members::DDL),
        crate::snapshot::table::<weldpass_vaults::Entity>(&weldpass_vaults::DDL),
        crate::snapshot::table::<whatsapp_templates::Entity>(&whatsapp_templates::DDL),
        crate::snapshot::table::<whiteboards::Entity>(&whiteboards::DDL),
        crate::snapshot::table::<workflow_error_logs::Entity>(&workflow_error_logs::DDL),
        crate::snapshot::table::<workflow_execution_steps::Entity>(&workflow_execution_steps::DDL),
        crate::snapshot::table::<workflow_executions::Entity>(&workflow_executions::DDL),
        crate::snapshot::table::<workflow_integrations::Entity>(&workflow_integrations::DDL),
        crate::snapshot::table::<workflow_schedules::Entity>(&workflow_schedules::DDL),
        crate::snapshot::table::<workflow_templates::Entity>(&workflow_templates::DDL),
        crate::snapshot::table::<workflow_trigger_index::Entity>(&workflow_trigger_index::DDL),
        crate::snapshot::table::<workflow_triggers::Entity>(&workflow_triggers::DDL),
        crate::snapshot::table::<workflow_variables::Entity>(&workflow_variables::DDL),
        crate::snapshot::table::<workflow_versions::Entity>(&workflow_versions::DDL),
        crate::snapshot::table::<workflow_webhooks::Entity>(&workflow_webhooks::DDL),
        crate::snapshot::table::<workflows::Entity>(&workflows::DDL),
        crate::snapshot::table::<workspace_api_keys::Entity>(&workspace_api_keys::DDL),
        crate::snapshot::table::<workspace_installed_apps::Entity>(&workspace_installed_apps::DDL),
        crate::snapshot::table::<workspace_members::Entity>(&workspace_members::DDL),
        crate::snapshot::table::<workspace_settings::Entity>(&workspace_settings::DDL),
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
        "access_requests" => json(Box::pin(access_requests::Entity::find().all(db)).await?),
        "accounting_bank_account_settings" => {
            json(Box::pin(accounting_bank_account_settings::Entity::find().all(db)).await?)
        }
        "accounting_contacts" => json(Box::pin(accounting_contacts::Entity::find().all(db)).await?),
        "accounting_dimension_values" => {
            json(Box::pin(accounting_dimension_values::Entity::find().all(db)).await?)
        }
        "accounting_entity_settings" => {
            json(Box::pin(accounting_entity_settings::Entity::find().all(db)).await?)
        }
        "accounts" => json(Box::pin(accounts::Entity::find().all(db)).await?),
        "active_timers" => json(Box::pin(active_timers::Entity::find().all(db)).await?),
        "activity_logs" => json(Box::pin(activity_logs::Entity::find().all(db)).await?),
        "ad_accounts" => json(Box::pin(ad_accounts::Entity::find().all(db)).await?),
        "ad_campaigns" => json(Box::pin(ad_campaigns::Entity::find().all(db)).await?),
        "ad_platform_connections" => {
            json(Box::pin(ad_platform_connections::Entity::find().all(db)).await?)
        }
        "ai_provider_keys" => json(Box::pin(ai_provider_keys::Entity::find().all(db)).await?),
        "ai_settings" => json(Box::pin(ai_settings::Entity::find().all(db)).await?),
        "analytics_charts" => json(Box::pin(analytics_charts::Entity::find().all(db)).await?),
        "analytics_reports" => json(Box::pin(analytics_reports::Entity::find().all(db)).await?),
        "api_keys" => json(Box::pin(api_keys::Entity::find().all(db)).await?),
        "app_kv" => json(Box::pin(app_kv::Entity::find().all(db)).await?),
        "app_records" => json(Box::pin(app_records::Entity::find().all(db)).await?),
        "asset_sources" => json(Box::pin(asset_sources::Entity::find().all(db)).await?),
        "audit_log" => json(Box::pin(audit_log::Entity::find().all(db)).await?),
        "audit_log_streams" => json(Box::pin(audit_log_streams::Entity::find().all(db)).await?),
        "audit_logs" => json(Box::pin(audit_logs::Entity::find().all(db)).await?),
        "bank_accounts" => json(Box::pin(bank_accounts::Entity::find().all(db)).await?),
        "bank_connections" => json(Box::pin(bank_connections::Entity::find().all(db)).await?),
        "bank_deposits" => json(Box::pin(bank_deposits::Entity::find().all(db)).await?),
        "bank_feed_pending_transactions" => {
            json(Box::pin(bank_feed_pending_transactions::Entity::find().all(db)).await?)
        }
        "bank_import_batches" => json(Box::pin(bank_import_batches::Entity::find().all(db)).await?),
        "bank_reconciliations" => {
            json(Box::pin(bank_reconciliations::Entity::find().all(db)).await?)
        }
        "bank_transactions" => json(Box::pin(bank_transactions::Entity::find().all(db)).await?),
        "bill_items" => json(Box::pin(bill_items::Entity::find().all(db)).await?),
        "bills" => json(Box::pin(bills::Entity::find().all(db)).await?),
        "board_versions" => json(Box::pin(board_versions::Entity::find().all(db)).await?),
        "boxes" => json(Box::pin(boxes::Entity::find().all(db)).await?),
        "calendar_booking_pages" => {
            json(Box::pin(calendar_booking_pages::Entity::find().all(db)).await?)
        }
        "calendar_bookings" => json(Box::pin(calendar_bookings::Entity::find().all(db)).await?),
        "calendar_events" => json(Box::pin(calendar_events::Entity::find().all(db)).await?),
        "calendar_shares" => json(Box::pin(calendar_shares::Entity::find().all(db)).await?),
        "calendars" => json(Box::pin(calendars::Entity::find().all(db)).await?),
        "carrier_services" => json(Box::pin(carrier_services::Entity::find().all(db)).await?),
        "carriers" => json(Box::pin(carriers::Entity::find().all(db)).await?),
        "categories" => json(Box::pin(categories::Entity::find().all(db)).await?),
        "category_products" => json(Box::pin(category_products::Entity::find().all(db)).await?),
        "chat_bookmarks" => json(Box::pin(chat_bookmarks::Entity::find().all(db)).await?),
        "chat_calls" => json(Box::pin(chat_calls::Entity::find().all(db)).await?),
        "chat_channel_members" => {
            json(Box::pin(chat_channel_members::Entity::find().all(db)).await?)
        }
        "chat_channel_role_links" => {
            json(Box::pin(chat_channel_role_links::Entity::find().all(db)).await?)
        }
        "chat_channels" => json(Box::pin(chat_channels::Entity::find().all(db)).await?),
        "chat_drafts" => json(Box::pin(chat_drafts::Entity::find().all(db)).await?),
        "chat_message_reads" => json(Box::pin(chat_message_reads::Entity::find().all(db)).await?),
        "chat_messages" => json(Box::pin(chat_messages::Entity::find().all(db)).await?),
        "chat_reminders" => json(Box::pin(chat_reminders::Entity::find().all(db)).await?),
        "chat_sections" => json(Box::pin(chat_sections::Entity::find().all(db)).await?),
        "chat_user_status" => json(Box::pin(chat_user_status::Entity::find().all(db)).await?),
        "commerce_portal_access" => {
            json(Box::pin(commerce_portal_access::Entity::find().all(db)).await?)
        }
        "commerce_portal_settings" => {
            json(Box::pin(commerce_portal_settings::Entity::find().all(db)).await?)
        }
        "companies" => json(Box::pin(companies::Entity::find().all(db)).await?),
        "connector_connections" => {
            json(Box::pin(connector_connections::Entity::find().all(db)).await?)
        }
        "connector_sync_runs" => json(Box::pin(connector_sync_runs::Entity::find().all(db)).await?),
        "contact_external_identities" => {
            json(Box::pin(contact_external_identities::Entity::find().all(db)).await?)
        }
        "crm_activities" => json(Box::pin(crm_activities::Entity::find().all(db)).await?),
        "crm_customer_statuses" => {
            json(Box::pin(crm_customer_statuses::Entity::find().all(db)).await?)
        }
        "crm_leads" => json(Box::pin(crm_leads::Entity::find().all(db)).await?),
        "crm_opportunities" => json(Box::pin(crm_opportunities::Entity::find().all(db)).await?),
        "crm_pipeline_stages" => json(Box::pin(crm_pipeline_stages::Entity::find().all(db)).await?),
        "crm_pipelines" => json(Box::pin(crm_pipelines::Entity::find().all(db)).await?),
        "crm_quotes" => json(Box::pin(crm_quotes::Entity::find().all(db)).await?),
        "crm_transcript_segments" => {
            json(Box::pin(crm_transcript_segments::Entity::find().all(db)).await?)
        }
        "crm_transcriptions" => json(Box::pin(crm_transcriptions::Entity::find().all(db)).await?),
        "custom_field_definitions" => {
            json(Box::pin(custom_field_definitions::Entity::find().all(db)).await?)
        }
        "custom_field_values" => json(Box::pin(custom_field_values::Entity::find().all(db)).await?),
        "custom_object_links" => json(Box::pin(custom_object_links::Entity::find().all(db)).await?),
        "custom_object_records" => {
            json(Box::pin(custom_object_records::Entity::find().all(db)).await?)
        }
        "custom_object_relations" => {
            json(Box::pin(custom_object_relations::Entity::find().all(db)).await?)
        }
        "custom_objects" => json(Box::pin(custom_objects::Entity::find().all(db)).await?),
        "cycle_count_items" => json(Box::pin(cycle_count_items::Entity::find().all(db)).await?),
        "cycle_counts" => json(Box::pin(cycle_counts::Entity::find().all(db)).await?),
        "desk_catalog_items" => json(Box::pin(desk_catalog_items::Entity::find().all(db)).await?),
        "desk_conversations" => json(Box::pin(desk_conversations::Entity::find().all(db)).await?),
        "desk_messages" => json(Box::pin(desk_messages::Entity::find().all(db)).await?),
        "desk_phone_agents" => json(Box::pin(desk_phone_agents::Entity::find().all(db)).await?),
        "desk_phone_call_legs" => {
            json(Box::pin(desk_phone_call_legs::Entity::find().all(db)).await?)
        }
        "desk_phone_routes" => json(Box::pin(desk_phone_routes::Entity::find().all(db)).await?),
        "desk_problems" => json(Box::pin(desk_problems::Entity::find().all(db)).await?),
        "desk_request_approvals" => {
            json(Box::pin(desk_request_approvals::Entity::find().all(db)).await?)
        }
        "desk_sla_clocks" => json(Box::pin(desk_sla_clocks::Entity::find().all(db)).await?),
        "desk_visitors" => json(Box::pin(desk_visitors::Entity::find().all(db)).await?),
        "desk_voice_agents" => json(Box::pin(desk_voice_agents::Entity::find().all(db)).await?),
        "desk_widget_settings" => {
            json(Box::pin(desk_widget_settings::Entity::find().all(db)).await?)
        }
        "device_tokens" => json(Box::pin(device_tokens::Entity::find().all(db)).await?),
        "discounts" => json(Box::pin(discounts::Entity::find().all(db)).await?),
        "dns_records" => json(Box::pin(dns_records::Entity::find().all(db)).await?),
        "dns_zones" => json(Box::pin(dns_zones::Entity::find().all(db)).await?),
        "doc_versions" => json(Box::pin(doc_versions::Entity::find().all(db)).await?),
        "docs" => json(Box::pin(docs::Entity::find().all(db)).await?),
        "document_versions" => json(Box::pin(document_versions::Entity::find().all(db)).await?),
        "documents" => json(Box::pin(documents::Entity::find().all(db)).await?),
        "domain_transfers" => json(Box::pin(domain_transfers::Entity::find().all(db)).await?),
        "domains" => json(Box::pin(domains::Entity::find().all(db)).await?),
        "drive_shares" => json(Box::pin(drive_shares::Entity::find().all(db)).await?),
        "email_forwards" => json(Box::pin(email_forwards::Entity::find().all(db)).await?),
        "email_templates" => json(Box::pin(email_templates::Entity::find().all(db)).await?),
        "enrich_field_definitions" => {
            json(Box::pin(enrich_field_definitions::Entity::find().all(db)).await?)
        }
        "enrich_field_results" => {
            json(Box::pin(enrich_field_results::Entity::find().all(db)).await?)
        }
        "enrichment_logs" => json(Box::pin(enrichment_logs::Entity::find().all(db)).await?),
        "entities" => json(Box::pin(entities::Entity::find().all(db)).await?),
        "entity_number_sequences" => {
            json(Box::pin(entity_number_sequences::Entity::find().all(db)).await?)
        }
        "exemption_certificates" => {
            json(Box::pin(exemption_certificates::Entity::find().all(db)).await?)
        }
        "external_webhooks" => json(Box::pin(external_webhooks::Entity::find().all(db)).await?),
        "files" => json(Box::pin(files::Entity::find().all(db)).await?),
        "fiscal_documents" => json(Box::pin(fiscal_documents::Entity::find().all(db)).await?),
        "fiscal_periods" => json(Box::pin(fiscal_periods::Entity::find().all(db)).await?),
        "fixed_asset_books" => json(Box::pin(fixed_asset_books::Entity::find().all(db)).await?),
        "fixed_asset_depreciation" => {
            json(Box::pin(fixed_asset_depreciation::Entity::find().all(db)).await?)
        }
        "fixed_assets" => json(Box::pin(fixed_assets::Entity::find().all(db)).await?),
        "flow_approval_delegations" => {
            json(Box::pin(flow_approval_delegations::Entity::find().all(db)).await?)
        }
        "flow_approvals" => json(Box::pin(flow_approvals::Entity::find().all(db)).await?),
        "flow_member_profiles" => {
            json(Box::pin(flow_member_profiles::Entity::find().all(db)).await?)
        }
        "flow_workspace_settings" => {
            json(Box::pin(flow_workspace_settings::Entity::find().all(db)).await?)
        }
        "folders" => json(Box::pin(folders::Entity::find().all(db)).await?),
        "form_1099_filing_lines" => {
            json(Box::pin(form_1099_filing_lines::Entity::find().all(db)).await?)
        }
        "form_1099_filings" => json(Box::pin(form_1099_filings::Entity::find().all(db)).await?),
        "form_access" => json(Box::pin(form_access::Entity::find().all(db)).await?),
        "form_ai_summaries" => json(Box::pin(form_ai_summaries::Entity::find().all(db)).await?),
        "form_folders" => json(Box::pin(form_folders::Entity::find().all(db)).await?),
        "form_integrations" => json(Box::pin(form_integrations::Entity::find().all(db)).await?),
        "form_invitations" => json(Box::pin(form_invitations::Entity::find().all(db)).await?),
        "form_response_actions" => {
            json(Box::pin(form_response_actions::Entity::find().all(db)).await?)
        }
        "form_response_files" => json(Box::pin(form_response_files::Entity::find().all(db)).await?),
        "form_responses" => json(Box::pin(form_responses::Entity::find().all(db)).await?),
        "form_settings" => json(Box::pin(form_settings::Entity::find().all(db)).await?),
        "form_subscriptions" => json(Box::pin(form_subscriptions::Entity::find().all(db)).await?),
        "form_themes" => json(Box::pin(form_themes::Entity::find().all(db)).await?),
        "form_versions" => json(Box::pin(form_versions::Entity::find().all(db)).await?),
        "forms" => json(Box::pin(forms::Entity::find().all(db)).await?),
        "fx_rates" => json(Box::pin(fx_rates::Entity::find().all(db)).await?),
        "github_connections" => json(Box::pin(github_connections::Entity::find().all(db)).await?),
        "github_issue_sync_map" => {
            json(Box::pin(github_issue_sync_map::Entity::find().all(db)).await?)
        }
        "github_project_links" => {
            json(Box::pin(github_project_links::Entity::find().all(db)).await?)
        }
        "github_repo_links" => json(Box::pin(github_repo_links::Entity::find().all(db)).await?),
        "grid_views" => json(Box::pin(grid_views::Entity::find().all(db)).await?),
        "helpcenter_domains" => json(Box::pin(helpcenter_domains::Entity::find().all(db)).await?),
        "helpcenter_settings" => json(Box::pin(helpcenter_settings::Entity::find().all(db)).await?),
        "helpdesk_agents" => json(Box::pin(helpdesk_agents::Entity::find().all(db)).await?),
        "helpdesk_analytics_charts" => {
            json(Box::pin(helpdesk_analytics_charts::Entity::find().all(db)).await?)
        }
        "helpdesk_analytics_reports" => {
            json(Box::pin(helpdesk_analytics_reports::Entity::find().all(db)).await?)
        }
        "helpdesk_announcements" => {
            json(Box::pin(helpdesk_announcements::Entity::find().all(db)).await?)
        }
        "helpdesk_article_folders" => {
            json(Box::pin(helpdesk_article_folders::Entity::find().all(db)).await?)
        }
        "helpdesk_articles" => json(Box::pin(helpdesk_articles::Entity::find().all(db)).await?),
        "helpdesk_canned_responses" => {
            json(Box::pin(helpdesk_canned_responses::Entity::find().all(db)).await?)
        }
        "helpdesk_changelog" => json(Box::pin(helpdesk_changelog::Entity::find().all(db)).await?),
        "helpdesk_channel_integrations" => {
            json(Box::pin(helpdesk_channel_integrations::Entity::find().all(db)).await?)
        }
        "helpdesk_conversation_events" => {
            json(Box::pin(helpdesk_conversation_events::Entity::find().all(db)).await?)
        }
        "helpdesk_conversation_messages" => {
            json(Box::pin(helpdesk_conversation_messages::Entity::find().all(db)).await?)
        }
        "helpdesk_conversations" => {
            json(Box::pin(helpdesk_conversations::Entity::find().all(db)).await?)
        }
        "helpdesk_departments" => {
            json(Box::pin(helpdesk_departments::Entity::find().all(db)).await?)
        }
        "helpdesk_faqs" => json(Box::pin(helpdesk_faqs::Entity::find().all(db)).await?),
        "helpdesk_feedback" => json(Box::pin(helpdesk_feedback::Entity::find().all(db)).await?),
        "helpdesk_news" => json(Box::pin(helpdesk_news::Entity::find().all(db)).await?),
        "helpdesk_report_schedules" => {
            json(Box::pin(helpdesk_report_schedules::Entity::find().all(db)).await?)
        }
        "helpdesk_reviews" => json(Box::pin(helpdesk_reviews::Entity::find().all(db)).await?),
        "helpdesk_satisfaction_surveys" => {
            json(Box::pin(helpdesk_satisfaction_surveys::Entity::find().all(db)).await?)
        }
        "helpdesk_settings" => json(Box::pin(helpdesk_settings::Entity::find().all(db)).await?),
        "helpdesk_slas" => json(Box::pin(helpdesk_slas::Entity::find().all(db)).await?),
        "helpdesk_ticket_messages" => {
            json(Box::pin(helpdesk_ticket_messages::Entity::find().all(db)).await?)
        }
        "helpdesk_ticket_notes" => {
            json(Box::pin(helpdesk_ticket_notes::Entity::find().all(db)).await?)
        }
        "helpdesk_ticket_types" => {
            json(Box::pin(helpdesk_ticket_types::Entity::find().all(db)).await?)
        }
        "helpdesk_tickets" => json(Box::pin(helpdesk_tickets::Entity::find().all(db)).await?),
        "helpdesk_widget_settings" => {
            json(Box::pin(helpdesk_widget_settings::Entity::find().all(db)).await?)
        }
        "helpdesk_workflow_executions" => {
            json(Box::pin(helpdesk_workflow_executions::Entity::find().all(db)).await?)
        }
        "helpdesk_workflows" => json(Box::pin(helpdesk_workflows::Entity::find().all(db)).await?),
        "hr_absences" => json(Box::pin(hr_absences::Entity::find().all(db)).await?),
        "hr_announcement_reads" => {
            json(Box::pin(hr_announcement_reads::Entity::find().all(db)).await?)
        }
        "hr_announcements" => json(Box::pin(hr_announcements::Entity::find().all(db)).await?),
        "hr_attendance_records" => {
            json(Box::pin(hr_attendance_records::Entity::find().all(db)).await?)
        }
        "hr_audit_events" => json(Box::pin(hr_audit_events::Entity::find().all(db)).await?),
        "hr_checklist_tasks" => json(Box::pin(hr_checklist_tasks::Entity::find().all(db)).await?),
        "hr_checklist_templates" => {
            json(Box::pin(hr_checklist_templates::Entity::find().all(db)).await?)
        }
        "hr_checklists" => json(Box::pin(hr_checklists::Entity::find().all(db)).await?),
        "hr_client_assignments" => {
            json(Box::pin(hr_client_assignments::Entity::find().all(db)).await?)
        }
        "hr_coaching_logs" => json(Box::pin(hr_coaching_logs::Entity::find().all(db)).await?),
        "hr_compensations" => json(Box::pin(hr_compensations::Entity::find().all(db)).await?),
        "hr_declarations" => json(Box::pin(hr_declarations::Entity::find().all(db)).await?),
        "hr_departments" => json(Box::pin(hr_departments::Entity::find().all(db)).await?),
        "hr_employees" => json(Box::pin(hr_employees::Entity::find().all(db)).await?),
        "hr_evaluation_forms" => json(Box::pin(hr_evaluation_forms::Entity::find().all(db)).await?),
        "hr_evaluations" => json(Box::pin(hr_evaluations::Entity::find().all(db)).await?),
        "hr_kpi_definitions" => json(Box::pin(hr_kpi_definitions::Entity::find().all(db)).await?),
        "hr_kpi_values" => json(Box::pin(hr_kpi_values::Entity::find().all(db)).await?),
        "hr_leave_allowances" => json(Box::pin(hr_leave_allowances::Entity::find().all(db)).await?),
        "hr_leave_requests" => json(Box::pin(hr_leave_requests::Entity::find().all(db)).await?),
        "hr_leave_types" => json(Box::pin(hr_leave_types::Entity::find().all(db)).await?),
        "hr_milestones" => json(Box::pin(hr_milestones::Entity::find().all(db)).await?),
        "hr_open_shifts" => json(Box::pin(hr_open_shifts::Entity::find().all(db)).await?),
        "hr_pay_components" => json(Box::pin(hr_pay_components::Entity::find().all(db)).await?),
        "hr_pay_run_inputs" => json(Box::pin(hr_pay_run_inputs::Entity::find().all(db)).await?),
        "hr_pay_runs" => json(Box::pin(hr_pay_runs::Entity::find().all(db)).await?),
        "hr_pay_schedules" => json(Box::pin(hr_pay_schedules::Entity::find().all(db)).await?),
        "hr_payroll_employers" => {
            json(Box::pin(hr_payroll_employers::Entity::find().all(db)).await?)
        }
        "hr_payroll_filings" => json(Box::pin(hr_payroll_filings::Entity::find().all(db)).await?),
        "hr_payroll_profiles" => json(Box::pin(hr_payroll_profiles::Entity::find().all(db)).await?),
        "hr_payslips" => json(Box::pin(hr_payslips::Entity::find().all(db)).await?),
        "hr_settings" => json(Box::pin(hr_settings::Entity::find().all(db)).await?),
        "hr_shift_requests" => json(Box::pin(hr_shift_requests::Entity::find().all(db)).await?),
        "hr_shifts" => json(Box::pin(hr_shifts::Entity::find().all(db)).await?),
        "hr_tax_elections" => json(Box::pin(hr_tax_elections::Entity::find().all(db)).await?),
        "hr_work_locations" => json(Box::pin(hr_work_locations::Entity::find().all(db)).await?),
        "icp_declarations" => json(Box::pin(icp_declarations::Entity::find().all(db)).await?),
        "icp_lines" => json(Box::pin(icp_lines::Entity::find().all(db)).await?),
        "integration_connections" => {
            json(Box::pin(integration_connections::Entity::find().all(db)).await?)
        }
        "integration_entity_mappings" => {
            json(Box::pin(integration_entity_mappings::Entity::find().all(db)).await?)
        }
        "integration_field_mappings" => {
            json(Box::pin(integration_field_mappings::Entity::find().all(db)).await?)
        }
        "integration_sync_conflicts" => {
            json(Box::pin(integration_sync_conflicts::Entity::find().all(db)).await?)
        }
        "inventory" => json(Box::pin(inventory::Entity::find().all(db)).await?),
        "inventory_movements" => json(Box::pin(inventory_movements::Entity::find().all(db)).await?),
        "invoice_items" => json(Box::pin(invoice_items::Entity::find().all(db)).await?),
        "invoice_templates" => json(Box::pin(invoice_templates::Entity::find().all(db)).await?),
        "invoices" => json(Box::pin(invoices::Entity::find().all(db)).await?),
        "journal_entries" => json(Box::pin(journal_entries::Entity::find().all(db)).await?),
        "journal_lines" => json(Box::pin(journal_lines::Entity::find().all(db)).await?),
        "knowledge_favorites" => json(Box::pin(knowledge_favorites::Entity::find().all(db)).await?),
        "knowledge_page_versions" => {
            json(Box::pin(knowledge_page_versions::Entity::find().all(db)).await?)
        }
        "knowledge_pages" => json(Box::pin(knowledge_pages::Entity::find().all(db)).await?),
        "knowledge_space_members" => {
            json(Box::pin(knowledge_space_members::Entity::find().all(db)).await?)
        }
        "knowledge_spaces" => json(Box::pin(knowledge_spaces::Entity::find().all(db)).await?),
        "legal_entity_members" => {
            json(Box::pin(legal_entity_members::Entity::find().all(db)).await?)
        }
        "legal_entity_registrations" => {
            json(Box::pin(legal_entity_registrations::Entity::find().all(db)).await?)
        }
        "list_members" => json(Box::pin(list_members::Entity::find().all(db)).await?),
        "lists" => json(Box::pin(lists::Entity::find().all(db)).await?),
        "lock_date_exceptions" => {
            json(Box::pin(lock_date_exceptions::Entity::find().all(db)).await?)
        }
        "mail_accounts" => json(Box::pin(mail_accounts::Entity::find().all(db)).await?),
        "mail_attachments" => json(Box::pin(mail_attachments::Entity::find().all(db)).await?),
        "mail_campaigns" => json(Box::pin(mail_campaigns::Entity::find().all(db)).await?),
        "mail_correspondents" => json(Box::pin(mail_correspondents::Entity::find().all(db)).await?),
        "mail_domains" => json(Box::pin(mail_domains::Entity::find().all(db)).await?),
        "mail_drafts" => json(Box::pin(mail_drafts::Entity::find().all(db)).await?),
        "mail_folders" => json(Box::pin(mail_folders::Entity::find().all(db)).await?),
        "mail_labels" => json(Box::pin(mail_labels::Entity::find().all(db)).await?),
        "mail_messages" => json(Box::pin(mail_messages::Entity::find().all(db)).await?),
        "mail_rules" => json(Box::pin(mail_rules::Entity::find().all(db)).await?),
        "mail_signatures" => json(Box::pin(mail_signatures::Entity::find().all(db)).await?),
        "mail_subscriptions" => json(Box::pin(mail_subscriptions::Entity::find().all(db)).await?),
        "mail_suppressions" => json(Box::pin(mail_suppressions::Entity::find().all(db)).await?),
        "mail_templates" => json(Box::pin(mail_templates::Entity::find().all(db)).await?),
        "meeting_bot_instances" => {
            json(Box::pin(meeting_bot_instances::Entity::find().all(db)).await?)
        }
        "meeting_bot_sessions" => {
            json(Box::pin(meeting_bot_sessions::Entity::find().all(db)).await?)
        }
        "meeting_messages" => json(Box::pin(meeting_messages::Entity::find().all(db)).await?),
        "meeting_session_waitlist" => {
            json(Box::pin(meeting_session_waitlist::Entity::find().all(db)).await?)
        }
        "meeting_sessions" => json(Box::pin(meeting_sessions::Entity::find().all(db)).await?),
        "meetings" => json(Box::pin(meetings::Entity::find().all(db)).await?),
        "member_notes" => json(Box::pin(member_notes::Entity::find().all(db)).await?),
        "merge_chat_subscriptions" => {
            json(Box::pin(merge_chat_subscriptions::Entity::find().all(db)).await?)
        }
        "merge_comments" => json(Box::pin(merge_comments::Entity::find().all(db)).await?),
        "merge_connections" => json(Box::pin(merge_connections::Entity::find().all(db)).await?),
        "merge_cycles" => json(Box::pin(merge_cycles::Entity::find().all(db)).await?),
        "merge_external_issues" => {
            json(Box::pin(merge_external_issues::Entity::find().all(db)).await?)
        }
        "merge_inbox_states" => json(Box::pin(merge_inbox_states::Entity::find().all(db)).await?),
        "merge_issue_pull_requests" => {
            json(Box::pin(merge_issue_pull_requests::Entity::find().all(db)).await?)
        }
        "merge_issues" => json(Box::pin(merge_issues::Entity::find().all(db)).await?),
        "merge_labels" => json(Box::pin(merge_labels::Entity::find().all(db)).await?),
        "merge_provider_accounts" => {
            json(Box::pin(merge_provider_accounts::Entity::find().all(db)).await?)
        }
        "merge_pull_requests" => json(Box::pin(merge_pull_requests::Entity::find().all(db)).await?),
        "merge_record_links" => json(Box::pin(merge_record_links::Entity::find().all(db)).await?),
        "merge_release_pull_requests" => {
            json(Box::pin(merge_release_pull_requests::Entity::find().all(db)).await?)
        }
        "merge_releases" => json(Box::pin(merge_releases::Entity::find().all(db)).await?),
        "merge_repositories" => json(Box::pin(merge_repositories::Entity::find().all(db)).await?),
        "merge_teams" => json(Box::pin(merge_teams::Entity::find().all(db)).await?),
        "milestones" => json(Box::pin(milestones::Entity::find().all(db)).await?),
        "notification_preferences" => {
            json(Box::pin(notification_preferences::Entity::find().all(db)).await?)
        }
        "notifications" => json(Box::pin(notifications::Entity::find().all(db)).await?),
        "object_templates" => json(Box::pin(object_templates::Entity::find().all(db)).await?),
        "order_items" => json(Box::pin(order_items::Entity::find().all(db)).await?),
        "orders" => json(Box::pin(orders::Entity::find().all(db)).await?),
        "panel_ai_summaries" => json(Box::pin(panel_ai_summaries::Entity::find().all(db)).await?),
        "panel_alert_events" => json(Box::pin(panel_alert_events::Entity::find().all(db)).await?),
        "panel_alerts" => json(Box::pin(panel_alerts::Entity::find().all(db)).await?),
        "panel_annotations" => json(Box::pin(panel_annotations::Entity::find().all(db)).await?),
        "panel_cohorts" => json(Box::pin(panel_cohorts::Entity::find().all(db)).await?),
        "panel_comments" => json(Box::pin(panel_comments::Entity::find().all(db)).await?),
        "panel_computed_properties" => {
            json(Box::pin(panel_computed_properties::Entity::find().all(db)).await?)
        }
        "panel_custom_events" => json(Box::pin(panel_custom_events::Entity::find().all(db)).await?),
        "panel_dashboard_tiles" => {
            json(Box::pin(panel_dashboard_tiles::Entity::find().all(db)).await?)
        }
        "panel_dashboards" => json(Box::pin(panel_dashboards::Entity::find().all(db)).await?),
        "panel_erased_ids" => json(Box::pin(panel_erased_ids::Entity::find().all(db)).await?),
        "panel_event_definitions" => {
            json(Box::pin(panel_event_definitions::Entity::find().all(db)).await?)
        }
        "panel_export_runs" => json(Box::pin(panel_export_runs::Entity::find().all(db)).await?),
        "panel_exports" => json(Box::pin(panel_exports::Entity::find().all(db)).await?),
        "panel_group_slots" => json(Box::pin(panel_group_slots::Entity::find().all(db)).await?),
        "panel_group_types" => json(Box::pin(panel_group_types::Entity::find().all(db)).await?),
        "panel_groups" => json(Box::pin(panel_groups::Entity::find().all(db)).await?),
        "panel_heatmap_pages" => json(Box::pin(panel_heatmap_pages::Entity::find().all(db)).await?),
        "panel_identity_links" => {
            json(Box::pin(panel_identity_links::Entity::find().all(db)).await?)
        }
        "panel_metric_trees" => json(Box::pin(panel_metric_trees::Entity::find().all(db)).await?),
        "panel_path_rules" => json(Box::pin(panel_path_rules::Entity::find().all(db)).await?),
        "panel_people" => json(Box::pin(panel_people::Entity::find().all(db)).await?),
        "panel_project_meta" => json(Box::pin(panel_project_meta::Entity::find().all(db)).await?),
        "panel_projects" => json(Box::pin(panel_projects::Entity::find().all(db)).await?),
        "panel_report_versions" => {
            json(Box::pin(panel_report_versions::Entity::find().all(db)).await?)
        }
        "panel_reports" => json(Box::pin(panel_reports::Entity::find().all(db)).await?),
        "panel_session_favorites" => {
            json(Box::pin(panel_session_favorites::Entity::find().all(db)).await?)
        }
        "panel_share_links" => json(Box::pin(panel_share_links::Entity::find().all(db)).await?),
        "panel_subscriptions" => json(Box::pin(panel_subscriptions::Entity::find().all(db)).await?),
        "parcels" => json(Box::pin(parcels::Entity::find().all(db)).await?),
        "parties" => json(Box::pin(parties::Entity::find().all(db)).await?),
        "payment_allocations" => json(Box::pin(payment_allocations::Entity::find().all(db)).await?),
        "payment_runs" => json(Box::pin(payment_runs::Entity::find().all(db)).await?),
        "payments" => json(Box::pin(payments::Entity::find().all(db)).await?),
        "payroll_connections" => json(Box::pin(payroll_connections::Entity::find().all(db)).await?),
        "payroll_imports" => json(Box::pin(payroll_imports::Entity::find().all(db)).await?),
        "pending_uploads" => json(Box::pin(pending_uploads::Entity::find().all(db)).await?),
        "people" => json(Box::pin(people::Entity::find().all(db)).await?),
        "person_companies" => json(Box::pin(person_companies::Entity::find().all(db)).await?),
        "pick_list_items" => json(Box::pin(pick_list_items::Entity::find().all(db)).await?),
        "pick_lists" => json(Box::pin(pick_lists::Entity::find().all(db)).await?),
        "pickups" => json(Box::pin(pickups::Entity::find().all(db)).await?),
        "product_connections" => json(Box::pin(product_connections::Entity::find().all(db)).await?),
        "product_sales_channels" => {
            json(Box::pin(product_sales_channels::Entity::find().all(db)).await?)
        }
        "product_suppliers" => json(Box::pin(product_suppliers::Entity::find().all(db)).await?),
        "product_variants" => json(Box::pin(product_variants::Entity::find().all(db)).await?),
        "products" => json(Box::pin(products::Entity::find().all(db)).await?),
        "project_baselines" => json(Box::pin(project_baselines::Entity::find().all(db)).await?),
        "project_benefit_measurements" => {
            json(Box::pin(project_benefit_measurements::Entity::find().all(db)).await?)
        }
        "project_benefits" => json(Box::pin(project_benefits::Entity::find().all(db)).await?),
        "project_change_requests" => {
            json(Box::pin(project_change_requests::Entity::find().all(db)).await?)
        }
        "project_control_links" => {
            json(Box::pin(project_control_links::Entity::find().all(db)).await?)
        }
        "project_decisions" => json(Box::pin(project_decisions::Entity::find().all(db)).await?),
        "project_deliverables" => {
            json(Box::pin(project_deliverables::Entity::find().all(db)).await?)
        }
        "project_documents" => json(Box::pin(project_documents::Entity::find().all(db)).await?),
        "project_files" => json(Box::pin(project_files::Entity::find().all(db)).await?),
        "project_finance_snapshots" => {
            json(Box::pin(project_finance_snapshots::Entity::find().all(db)).await?)
        }
        "project_goals" => json(Box::pin(project_goals::Entity::find().all(db)).await?),
        "project_labels" => json(Box::pin(project_labels::Entity::find().all(db)).await?),
        "project_lessons" => json(Box::pin(project_lessons::Entity::find().all(db)).await?),
        "project_members" => json(Box::pin(project_members::Entity::find().all(db)).await?),
        "project_messages" => json(Box::pin(project_messages::Entity::find().all(db)).await?),
        "project_phases" => json(Box::pin(project_phases::Entity::find().all(db)).await?),
        "project_pipeline_stages" => {
            json(Box::pin(project_pipeline_stages::Entity::find().all(db)).await?)
        }
        "project_raci" => json(Box::pin(project_raci::Entity::find().all(db)).await?),
        "project_raid_assessments" => {
            json(Box::pin(project_raid_assessments::Entity::find().all(db)).await?)
        }
        "project_raid_items" => json(Box::pin(project_raid_items::Entity::find().all(db)).await?),
        "project_requests" => json(Box::pin(project_requests::Entity::find().all(db)).await?),
        "project_scope" => json(Box::pin(project_scope::Entity::find().all(db)).await?),
        "project_stakeholders" => {
            json(Box::pin(project_stakeholders::Entity::find().all(db)).await?)
        }
        "project_status_reports" => {
            json(Box::pin(project_status_reports::Entity::find().all(db)).await?)
        }
        "project_templates" => json(Box::pin(project_templates::Entity::find().all(db)).await?),
        "project_whiteboards" => json(Box::pin(project_whiteboards::Entity::find().all(db)).await?),
        "projects" => json(Box::pin(projects::Entity::find().all(db)).await?),
        "purchase_order_items" => {
            json(Box::pin(purchase_order_items::Entity::find().all(db)).await?)
        }
        "purchase_order_receipts" => {
            json(Box::pin(purchase_order_receipts::Entity::find().all(db)).await?)
        }
        "purchase_orders" => json(Box::pin(purchase_orders::Entity::find().all(db)).await?),
        "reach_campaign_mailboxes" => {
            json(Box::pin(reach_campaign_mailboxes::Entity::find().all(db)).await?)
        }
        "reach_campaign_steps" => {
            json(Box::pin(reach_campaign_steps::Entity::find().all(db)).await?)
        }
        "reach_campaigns" => json(Box::pin(reach_campaigns::Entity::find().all(db)).await?),
        "reach_domains" => json(Box::pin(reach_domains::Entity::find().all(db)).await?),
        "reach_enrollments" => json(Box::pin(reach_enrollments::Entity::find().all(db)).await?),
        "reach_mailboxes" => json(Box::pin(reach_mailboxes::Entity::find().all(db)).await?),
        "reach_messages" => json(Box::pin(reach_messages::Entity::find().all(db)).await?),
        "reach_prospect_list_members" => {
            json(Box::pin(reach_prospect_list_members::Entity::find().all(db)).await?)
        }
        "reach_prospect_lists" => {
            json(Box::pin(reach_prospect_lists::Entity::find().all(db)).await?)
        }
        "reach_prospects" => json(Box::pin(reach_prospects::Entity::find().all(db)).await?),
        "reach_settings" => json(Box::pin(reach_settings::Entity::find().all(db)).await?),
        "reach_suppressions" => json(Box::pin(reach_suppressions::Entity::find().all(db)).await?),
        "received_fiscal_documents" => {
            json(Box::pin(received_fiscal_documents::Entity::find().all(db)).await?)
        }
        "reconciliation_rules" => {
            json(Box::pin(reconciliation_rules::Entity::find().all(db)).await?)
        }
        "recurring_invoices" => json(Box::pin(recurring_invoices::Entity::find().all(db)).await?),
        "resource_bookings" => json(Box::pin(resource_bookings::Entity::find().all(db)).await?),
        "resource_requests" => json(Box::pin(resource_requests::Entity::find().all(db)).await?),
        "return_reason_groups" => {
            json(Box::pin(return_reason_groups::Entity::find().all(db)).await?)
        }
        "return_reasons" => json(Box::pin(return_reasons::Entity::find().all(db)).await?),
        "return_rules" => json(Box::pin(return_rules::Entity::find().all(db)).await?),
        "returns" => json(Box::pin(returns::Entity::find().all(db)).await?),
        "roles" => json(Box::pin(roles::Entity::find().all(db)).await?),
        "sales_tax_agencies" => json(Box::pin(sales_tax_agencies::Entity::find().all(db)).await?),
        "sales_tax_jurisdiction_rates" => {
            json(Box::pin(sales_tax_jurisdiction_rates::Entity::find().all(db)).await?)
        }
        "sales_tax_jurisdictions" => {
            json(Box::pin(sales_tax_jurisdictions::Entity::find().all(db)).await?)
        }
        "sales_tax_taxability_rules" => {
            json(Box::pin(sales_tax_taxability_rules::Entity::find().all(db)).await?)
        }
        "sales_tax_zones" => json(Box::pin(sales_tax_zones::Entity::find().all(db)).await?),
        "search_index" => json(Box::pin(search_index::Entity::find().all(db)).await?),
        "sequence_enrollments" => {
            json(Box::pin(sequence_enrollments::Entity::find().all(db)).await?)
        }
        "settings" => json(Box::pin(settings::Entity::find().all(db)).await?),
        "sheet_data_sources" => json(Box::pin(sheet_data_sources::Entity::find().all(db)).await?),
        "sheet_versions" => json(Box::pin(sheet_versions::Entity::find().all(db)).await?),
        "sheets" => json(Box::pin(sheets::Entity::find().all(db)).await?),
        "shipments" => json(Box::pin(shipments::Entity::find().all(db)).await?),
        "shipping_prices" => json(Box::pin(shipping_prices::Entity::find().all(db)).await?),
        "shipping_rules" => json(Box::pin(shipping_rules::Entity::find().all(db)).await?),
        "sign_documents" => json(Box::pin(sign_documents::Entity::find().all(db)).await?),
        "sign_envelopes" => json(Box::pin(sign_envelopes::Entity::find().all(db)).await?),
        "sign_events" => json(Box::pin(sign_events::Entity::find().all(db)).await?),
        "sign_fields" => json(Box::pin(sign_fields::Entity::find().all(db)).await?),
        "sign_recipients" => json(Box::pin(sign_recipients::Entity::find().all(db)).await?),
        "sign_settings" => json(Box::pin(sign_settings::Entity::find().all(db)).await?),
        "sms_templates" => json(Box::pin(sms_templates::Entity::find().all(db)).await?),
        "social_accounts" => json(Box::pin(social_accounts::Entity::find().all(db)).await?),
        "social_analytics" => json(Box::pin(social_analytics::Entity::find().all(db)).await?),
        "social_approval_history" => {
            json(Box::pin(social_approval_history::Entity::find().all(db)).await?)
        }
        "social_approvals" => json(Box::pin(social_approvals::Entity::find().all(db)).await?),
        "social_campaigns" => json(Box::pin(social_campaigns::Entity::find().all(db)).await?),
        "social_media" => json(Box::pin(social_media::Entity::find().all(db)).await?),
        "social_posts" => json(Box::pin(social_posts::Entity::find().all(db)).await?),
        "social_team_members" => json(Box::pin(social_team_members::Entity::find().all(db)).await?),
        "sprints" => json(Box::pin(sprints::Entity::find().all(db)).await?),
        "stash_item_plans" => json(Box::pin(stash_item_plans::Entity::find().all(db)).await?),
        "stash_planning_runs" => json(Box::pin(stash_planning_runs::Entity::find().all(db)).await?),
        "stash_reorder_rules" => json(Box::pin(stash_reorder_rules::Entity::find().all(db)).await?),
        "stash_sales_history" => json(Box::pin(stash_sales_history::Entity::find().all(db)).await?),
        "stash_sales_history_imports" => {
            json(Box::pin(stash_sales_history_imports::Entity::find().all(db)).await?)
        }
        "stash_settings" => json(Box::pin(stash_settings::Entity::find().all(db)).await?),
        "stock_adjustments" => json(Box::pin(stock_adjustments::Entity::find().all(db)).await?),
        "suppliers" => json(Box::pin(suppliers::Entity::find().all(db)).await?),
        "support_channel_members" => {
            json(Box::pin(support_channel_members::Entity::find().all(db)).await?)
        }
        "support_channels" => json(Box::pin(support_channels::Entity::find().all(db)).await?),
        "support_messages" => json(Box::pin(support_messages::Entity::find().all(db)).await?),
        "sync_logs" => json(Box::pin(sync_logs::Entity::find().all(db)).await?),
        "system_settings" => json(Box::pin(system_settings::Entity::find().all(db)).await?),
        "task_comments" => json(Box::pin(task_comments::Entity::find().all(db)).await?),
        "task_dependencies" => json(Box::pin(task_dependencies::Entity::find().all(db)).await?),
        "task_digest_settings" => {
            json(Box::pin(task_digest_settings::Entity::find().all(db)).await?)
        }
        "task_import_jobs" => json(Box::pin(task_import_jobs::Entity::find().all(db)).await?),
        "task_number_sequences" => {
            json(Box::pin(task_number_sequences::Entity::find().all(db)).await?)
        }
        "task_projects" => json(Box::pin(task_projects::Entity::find().all(db)).await?),
        "task_tags" => json(Box::pin(task_tags::Entity::find().all(db)).await?),
        "tasks" => json(Box::pin(tasks::Entity::find().all(db)).await?),
        "tax_calendar_completions" => {
            json(Box::pin(tax_calendar_completions::Entity::find().all(db)).await?)
        }
        "tax_id_reveals" => json(Box::pin(tax_id_reveals::Entity::find().all(db)).await?),
        "tax_lines" => json(Box::pin(tax_lines::Entity::find().all(db)).await?),
        "tax_rates" => json(Box::pin(tax_rates::Entity::find().all(db)).await?),
        "tax_returns" => json(Box::pin(tax_returns::Entity::find().all(db)).await?),
        "time_entries" => json(Box::pin(time_entries::Entity::find().all(db)).await?),
        "tracking_events" => json(Box::pin(tracking_events::Entity::find().all(db)).await?),
        "user_app_assignments" => {
            json(Box::pin(user_app_assignments::Entity::find().all(db)).await?)
        }
        "user_preferences" => json(Box::pin(user_preferences::Entity::find().all(db)).await?),
        "vat_returns" => json(Box::pin(vat_returns::Entity::find().all(db)).await?),
        "vies_checks" => json(Box::pin(vies_checks::Entity::find().all(db)).await?),
        "voip_calls" => json(Box::pin(voip_calls::Entity::find().all(db)).await?),
        "voip_phone_numbers" => json(Box::pin(voip_phone_numbers::Entity::find().all(db)).await?),
        "voip_porting_orders" => json(Box::pin(voip_porting_orders::Entity::find().all(db)).await?),
        "voip_sip_trunks" => json(Box::pin(voip_sip_trunks::Entity::find().all(db)).await?),
        "w9_requests" => json(Box::pin(w9_requests::Entity::find().all(db)).await?),
        "wallet_transactions" => json(Box::pin(wallet_transactions::Entity::find().all(db)).await?),
        "wallets" => json(Box::pin(wallets::Entity::find().all(db)).await?),
        "warehouse_locations" => json(Box::pin(warehouse_locations::Entity::find().all(db)).await?),
        "warehouse_workers" => json(Box::pin(warehouse_workers::Entity::find().all(db)).await?),
        "warehouse_zones" => json(Box::pin(warehouse_zones::Entity::find().all(db)).await?),
        "warehouses" => json(Box::pin(warehouses::Entity::find().all(db)).await?),
        "webhook_deliveries" => json(Box::pin(webhook_deliveries::Entity::find().all(db)).await?),
        "weldagent_agent_members" => {
            json(Box::pin(weldagent_agent_members::Entity::find().all(db)).await?)
        }
        "weldagent_agent_runs" => {
            json(Box::pin(weldagent_agent_runs::Entity::find().all(db)).await?)
        }
        "weldagent_agent_skills" => {
            json(Box::pin(weldagent_agent_skills::Entity::find().all(db)).await?)
        }
        "weldagent_agents" => json(Box::pin(weldagent_agents::Entity::find().all(db)).await?),
        "weldagent_approvals" => json(Box::pin(weldagent_approvals::Entity::find().all(db)).await?),
        "weldagent_conversations" => {
            json(Box::pin(weldagent_conversations::Entity::find().all(db)).await?)
        }
        "weldagent_memories" => json(Box::pin(weldagent_memories::Entity::find().all(db)).await?),
        "weldagent_messages" => json(Box::pin(weldagent_messages::Entity::find().all(db)).await?),
        "weldagent_routine_runs" => {
            json(Box::pin(weldagent_routine_runs::Entity::find().all(db)).await?)
        }
        "weldagent_routines" => json(Box::pin(weldagent_routines::Entity::find().all(db)).await?),
        "weldagent_skills" => json(Box::pin(weldagent_skills::Entity::find().all(db)).await?),
        "weldagent_teach_sessions" => {
            json(Box::pin(weldagent_teach_sessions::Entity::find().all(db)).await?)
        }
        "weldagent_templates" => json(Box::pin(weldagent_templates::Entity::find().all(db)).await?),
        "welddata_cells" => json(Box::pin(welddata_cells::Entity::find().all(db)).await?),
        "welddata_columns" => json(Box::pin(welddata_columns::Entity::find().all(db)).await?),
        "welddata_leads" => json(Box::pin(welddata_leads::Entity::find().all(db)).await?),
        "welddata_lists" => json(Box::pin(welddata_lists::Entity::find().all(db)).await?),
        "weldpass_audit_events" => {
            json(Box::pin(weldpass_audit_events::Entity::find().all(db)).await?)
        }
        "weldpass_environments" => {
            json(Box::pin(weldpass_environments::Entity::find().all(db)).await?)
        }
        "weldpass_item_versions" => {
            json(Box::pin(weldpass_item_versions::Entity::find().all(db)).await?)
        }
        "weldpass_items" => json(Box::pin(weldpass_items::Entity::find().all(db)).await?),
        "weldpass_projects" => json(Box::pin(weldpass_projects::Entity::find().all(db)).await?),
        "weldpass_provider_credentials" => {
            json(Box::pin(weldpass_provider_credentials::Entity::find().all(db)).await?)
        }
        "weldpass_secret_versions" => {
            json(Box::pin(weldpass_secret_versions::Entity::find().all(db)).await?)
        }
        "weldpass_secrets" => json(Box::pin(weldpass_secrets::Entity::find().all(db)).await?),
        "weldpass_sync_runs" => json(Box::pin(weldpass_sync_runs::Entity::find().all(db)).await?),
        "weldpass_sync_targets" => {
            json(Box::pin(weldpass_sync_targets::Entity::find().all(db)).await?)
        }
        "weldpass_vault_events" => {
            json(Box::pin(weldpass_vault_events::Entity::find().all(db)).await?)
        }
        "weldpass_vault_members" => {
            json(Box::pin(weldpass_vault_members::Entity::find().all(db)).await?)
        }
        "weldpass_vaults" => json(Box::pin(weldpass_vaults::Entity::find().all(db)).await?),
        "whatsapp_templates" => json(Box::pin(whatsapp_templates::Entity::find().all(db)).await?),
        "whiteboards" => json(Box::pin(whiteboards::Entity::find().all(db)).await?),
        "workflow_error_logs" => json(Box::pin(workflow_error_logs::Entity::find().all(db)).await?),
        "workflow_execution_steps" => {
            json(Box::pin(workflow_execution_steps::Entity::find().all(db)).await?)
        }
        "workflow_executions" => json(Box::pin(workflow_executions::Entity::find().all(db)).await?),
        "workflow_integrations" => {
            json(Box::pin(workflow_integrations::Entity::find().all(db)).await?)
        }
        "workflow_schedules" => json(Box::pin(workflow_schedules::Entity::find().all(db)).await?),
        "workflow_templates" => json(Box::pin(workflow_templates::Entity::find().all(db)).await?),
        "workflow_trigger_index" => {
            json(Box::pin(workflow_trigger_index::Entity::find().all(db)).await?)
        }
        "workflow_triggers" => json(Box::pin(workflow_triggers::Entity::find().all(db)).await?),
        "workflow_variables" => json(Box::pin(workflow_variables::Entity::find().all(db)).await?),
        "workflow_versions" => json(Box::pin(workflow_versions::Entity::find().all(db)).await?),
        "workflow_webhooks" => json(Box::pin(workflow_webhooks::Entity::find().all(db)).await?),
        "workflows" => json(Box::pin(workflows::Entity::find().all(db)).await?),
        "workspace_api_keys" => json(Box::pin(workspace_api_keys::Entity::find().all(db)).await?),
        "workspace_installed_apps" => {
            json(Box::pin(workspace_installed_apps::Entity::find().all(db)).await?)
        }
        "workspace_members" => json(Box::pin(workspace_members::Entity::find().all(db)).await?),
        "workspace_settings" => json(Box::pin(workspace_settings::Entity::find().all(db)).await?),
        _ => return Ok(None),
    }))
}
