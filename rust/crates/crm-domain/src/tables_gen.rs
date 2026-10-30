//! Column lists of the tables the CRM writes, generated from the Drizzle
//! schema (`packages/core/db/src/schema`) so the inserts and updates name
//! every column. Regenerate when a table changes.
//!
//! Inserts and updates go through `jsonb_populate_record`: a write is a
//! JSON object of column values, as Drizzle's `values()`/`set()` take
//! them. An insert fills a column the object leaves out with the table's
//! literal default (`defaults`), as Drizzle leaves it to `DEFAULT`; an
//! update keeps it.

use crate::tables::Table;

/// `companies` (`schema.companies`): Drizzle key and column of each field.
pub const COMPANIES: Table = Table {
    name: "companies",
    columns: &[
        ("id", "id"),
        ("createdAt", "created_at"),
        ("updatedAt", "updated_at"),
        ("deletedAt", "deleted_at"),
        ("version", "version"),
        ("name", "name"),
        ("tradingName", "trading_name"),
        ("displayName", "display_name"),
        ("registrationNumber", "registration_number"),
        ("vatNumber", "vat_number"),
        ("industry", "industry"),
        ("employeeCount", "employee_count"),
        ("annualRevenue", "annual_revenue"),
        ("fundingRaised", "funding_raised"),
        ("foundationDate", "foundation_date"),
        ("description", "description"),
        ("website", "website"),
        ("email", "email"),
        ("alternateEmails", "alternate_emails"),
        ("phone", "phone"),
        ("mobile", "mobile"),
        ("fax", "fax"),
        ("primaryAddress", "primary_address"),
        ("addresses", "addresses"),
        ("avatarUrl", "avatar_url"),
        ("linkedinUrl", "linkedin_url"),
        ("twitterHandle", "twitter_handle"),
        ("facebookUrl", "facebook_url"),
        ("instagramUrl", "instagram_url"),
        ("angellistUrl", "angellist_url"),
        ("twitterFollowerCount", "twitter_follower_count"),
        ("createdBy", "created_by"),
        ("ownerId", "owner_id"),
        ("accountManagerId", "account_manager_id"),
        ("status", "status"),
        ("lifecycleStage", "lifecycle_stage"),
        ("segment", "segment"),
        ("rating", "rating"),
        ("source", "source"),
        ("isSupplier", "is_supplier"),
        ("isLead", "is_lead"),
        ("isFavorite", "is_favorite"),
        ("leadScore", "lead_score"),
        ("npsScore", "nps_score"),
        ("satisfactionScore", "satisfaction_score"),
        ("firstContactDate", "first_contact_date"),
        ("lastContactDate", "last_contact_date"),
        ("nextFollowUpDate", "next_follow_up_date"),
        ("preferredContactMethod", "preferred_contact_method"),
        ("preferredLanguage", "preferred_language"),
        ("timezone", "timezone"),
        ("marketingConsent", "marketing_consent"),
        ("emailOptIn", "email_opt_in"),
        ("smsOptIn", "sms_opt_in"),
        ("doNotCall", "do_not_call"),
        ("tags", "tags"),
        ("customFields", "custom_fields"),
        ("notes", "notes"),
        ("internalNotes", "internal_notes"),
        ("partyCode", "party_code"),
        ("archivedAt", "archived_at"),
    ],
    defaults: r#"{"version":1,"status":"prospect","is_supplier":false,"is_lead":false,"is_favorite":false,"lead_score":0,"marketing_consent":false,"email_opt_in":false,"sms_opt_in":false,"do_not_call":false}"#,
};

/// `crm_activities` (`schema.crmActivities`): Drizzle key and column of each field.
pub const CRM_ACTIVITIES: Table = Table {
    name: "crm_activities",
    columns: &[
        ("id", "id"),
        ("createdAt", "created_at"),
        ("updatedAt", "updated_at"),
        ("deletedAt", "deleted_at"),
        ("type", "type"),
        ("subject", "subject"),
        ("description", "description"),
        ("relatedTo", "related_to"),
        ("relatedToId", "related_to_id"),
        ("relatedToName", "related_to_name"),
        ("customerId", "customer_id"),
        ("contactId", "contact_id"),
        ("counterpartyId", "counterparty_id"),
        ("personId", "person_id"),
        ("leadId", "lead_id"),
        ("opportunityId", "opportunity_id"),
        ("assignedToId", "assigned_to_id"),
        ("dueDate", "due_date"),
        ("startTime", "start_time"),
        ("endTime", "end_time"),
        ("duration", "duration"),
        ("status", "status"),
        ("priority", "priority"),
        ("location", "location"),
        ("isVirtual", "is_virtual"),
        ("meetingUrl", "meeting_url"),
        ("callDirection", "call_direction"),
        ("callDuration", "call_duration"),
        ("callRecordingUrl", "call_recording_url"),
        ("emailMessageId", "email_message_id"),
        ("emailSubject", "email_subject"),
        ("emailFrom", "email_from"),
        ("emailTo", "email_to"),
        ("emailCc", "email_cc"),
        ("attendees", "attendees"),
        ("meetingAgenda", "meeting_agenda"),
        ("meetingNotes", "meeting_notes"),
        ("outcome", "outcome"),
        ("nextAction", "next_action"),
        ("followUpDate", "follow_up_date"),
        ("attachments", "attachments"),
        ("calendarEventId", "calendar_event_id"),
        ("isFavorite", "is_favorite"),
        ("tags", "tags"),
        ("customFields", "custom_fields"),
        ("labels", "labels"),
        ("assigneeIds", "assignee_ids"),
        ("repeat", "repeat"),
        ("changeLog", "change_log"),
    ],
    defaults: r#"{"status":"planned","priority":"medium","is_virtual":false,"is_favorite":false}"#,
};

/// `crm_customer_statuses` (`schema.crmCustomerStatuses`): Drizzle key and column of each field.
pub const CRM_CUSTOMER_STATUSES: Table = Table {
    name: "crm_customer_statuses",
    columns: &[
        ("id", "id"),
        ("createdAt", "created_at"),
        ("updatedAt", "updated_at"),
        ("deletedAt", "deleted_at"),
        ("name", "name"),
        ("slug", "slug"),
        ("color", "color"),
        ("sortOrder", "sort_order"),
    ],
    defaults: r#"{"color":"gray","sort_order":0}"#,
};

/// `crm_leads` (`schema.crmLeads`): Drizzle key and column of each field.
pub const CRM_LEADS: Table = Table {
    name: "crm_leads",
    columns: &[
        ("id", "id"),
        ("createdAt", "created_at"),
        ("updatedAt", "updated_at"),
        ("deletedAt", "deleted_at"),
        ("firstName", "first_name"),
        ("lastName", "last_name"),
        ("fullName", "full_name"),
        ("companyName", "company_name"),
        ("title", "title"),
        ("email", "email"),
        ("phone", "phone"),
        ("mobile", "mobile"),
        ("website", "website"),
        ("address", "address"),
        ("source", "source"),
        ("channel", "channel"),
        ("campaign", "campaign"),
        ("medium", "medium"),
        ("status", "status"),
        ("rating", "rating"),
        ("score", "score"),
        ("ownerId", "owner_id"),
        ("assignedAt", "assigned_at"),
        ("isQualified", "is_qualified"),
        ("qualifiedAt", "qualified_at"),
        ("disqualifiedReason", "disqualified_reason"),
        ("productInterest", "product_interest"),
        ("budget", "budget"),
        ("timeline", "timeline"),
        ("authority", "authority"),
        ("need", "need"),
        ("convertedAt", "converted_at"),
        ("convertedToCustomerId", "converted_to_customer_id"),
        ("convertedToCounterpartyId", "converted_to_counterparty_id"),
        ("convertedToOpportunityId", "converted_to_opportunity_id"),
        ("firstResponseAt", "first_response_at"),
        ("lastActivityAt", "last_activity_at"),
        ("numberOfTouches", "number_of_touches"),
        ("notes", "notes"),
        ("nextAction", "next_action"),
    ],
    defaults: r#"{"source":"other","status":"new","score":0,"is_qualified":false,"number_of_touches":0}"#,
};

/// `crm_opportunities` (`schema.crmOpportunities`): Drizzle key and column of each field.
pub const CRM_OPPORTUNITIES: Table = Table {
    name: "crm_opportunities",
    columns: &[
        ("id", "id"),
        ("createdAt", "created_at"),
        ("updatedAt", "updated_at"),
        ("deletedAt", "deleted_at"),
        ("name", "name"),
        ("description", "description"),
        ("customerId", "customer_id"),
        ("customerName", "customer_name"),
        ("contactIds", "contact_ids"),
        ("primaryContactId", "primary_contact_id"),
        ("counterpartyId", "counterparty_id"),
        ("personIds", "person_ids"),
        ("primaryPersonId", "primary_person_id"),
        ("amount", "amount"),
        ("currency", "currency"),
        ("expectedRevenue", "expected_revenue"),
        ("recurringRevenue", "recurring_revenue"),
        ("contractLength", "contract_length"),
        ("stageId", "stage_id"),
        ("stage", "stage"),
        ("probability", "probability"),
        ("pipeline", "pipeline"),
        ("salesProcess", "sales_process"),
        ("closeDate", "close_date"),
        ("actualCloseDate", "actual_close_date"),
        ("startDate", "start_date"),
        ("competitors", "competitors"),
        ("competitionStatus", "competition_status"),
        ("winLossReason", "win_loss_reason"),
        ("lineItems", "line_items"),
        ("ownerId", "owner_id"),
        ("teamMembers", "team_members"),
        ("leadSource", "lead_source"),
        ("campaign", "campaign"),
        ("type", "type"),
        ("category", "category"),
        ("status", "status"),
        ("forecastCategory", "forecast_category"),
        ("nextStep", "next_step"),
        ("nextStepDate", "next_step_date"),
        ("riskLevel", "risk_level"),
        ("riskReason", "risk_reason"),
        ("proposalUrl", "proposal_url"),
        ("contractUrl", "contract_url"),
        ("attachments", "attachments"),
        ("lastActivityDate", "last_activity_date"),
        ("daysInCurrentStage", "days_in_current_stage"),
        ("totalActivities", "total_activities"),
        ("customFields", "custom_fields"),
        ("tags", "tags"),
    ],
    defaults: r#"{"amount":"0","currency":"EUR","stage":"prospecting","probability":0,"pipeline":"default","status":"open","days_in_current_stage":0,"total_activities":0}"#,
};

/// `crm_pipeline_stages` (`schema.crmPipelineStages`): Drizzle key and column of each field.
pub const CRM_PIPELINE_STAGES: Table = Table {
    name: "crm_pipeline_stages",
    columns: &[
        ("id", "id"),
        ("createdAt", "created_at"),
        ("updatedAt", "updated_at"),
        ("deletedAt", "deleted_at"),
        ("name", "name"),
        ("description", "description"),
        ("position", "position"),
        ("probability", "probability"),
        ("color", "color"),
        ("pipeline", "pipeline"),
        ("isDefault", "is_default"),
        ("isWon", "is_won"),
        ("isLost", "is_lost"),
    ],
    defaults: r#"{"position":0,"probability":0,"pipeline":"default","is_default":false,"is_won":false,"is_lost":false}"#,
};

/// `crm_pipelines` (`schema.crmPipelines`): Drizzle key and column of each field.
pub const CRM_PIPELINES: Table = Table {
    name: "crm_pipelines",
    columns: &[
        ("id", "id"),
        ("createdAt", "created_at"),
        ("updatedAt", "updated_at"),
        ("deletedAt", "deleted_at"),
        ("name", "name"),
        ("description", "description"),
        ("icon", "icon"),
        ("color", "color"),
        ("template", "template"),
        ("settings", "settings"),
        ("isDefault", "is_default"),
        ("isArchived", "is_archived"),
    ],
    defaults: r#"{"is_default":false,"is_archived":false}"#,
};

/// `custom_field_definitions` (`schema.customFieldDefinitions`): Drizzle key and column of each field.
pub const CUSTOM_FIELD_DEFINITIONS: Table = Table {
    name: "custom_field_definitions",
    columns: &[
        ("id", "id"),
        ("createdAt", "created_at"),
        ("updatedAt", "updated_at"),
        ("deletedAt", "deleted_at"),
        ("entityType", "entity_type"),
        ("name", "name"),
        ("slug", "slug"),
        ("description", "description"),
        ("fieldType", "field_type"),
        ("options", "options"),
        ("config", "config"),
        ("required", "required"),
        ("sortOrder", "sort_order"),
        ("group", "group"),
        ("ticketTypeId", "ticket_type_id"),
    ],
    defaults: r#"{"required":false,"sort_order":0}"#,
};

/// `custom_field_values` (`schema.customFieldValues`): Drizzle key and column of each field.
pub const CUSTOM_FIELD_VALUES: Table = Table {
    name: "custom_field_values",
    columns: &[
        ("id", "id"),
        ("createdAt", "created_at"),
        ("updatedAt", "updated_at"),
        ("fieldId", "field_id"),
        ("entityType", "entity_type"),
        ("entityId", "entity_id"),
        ("valueText", "value_text"),
        ("valueNumber", "value_number"),
        ("valueDate", "value_date"),
        ("valueBool", "value_bool"),
        ("valueJson", "value_json"),
        ("valueRef", "value_ref"),
    ],
    defaults: "{}",
};

/// `list_members` (`schema.listMembers`): Drizzle key and column of each field.
pub const LIST_MEMBERS: Table = Table {
    name: "list_members",
    columns: &[
        ("id", "id"),
        ("addedAt", "added_at"),
        ("addedBy", "added_by"),
        ("listId", "list_id"),
        ("entityId", "entity_id"),
    ],
    defaults: "{}",
};

/// `lists` (`schema.lists`): Drizzle key and column of each field.
pub const LISTS: Table = Table {
    name: "lists",
    columns: &[
        ("id", "id"),
        ("createdAt", "created_at"),
        ("updatedAt", "updated_at"),
        ("deletedAt", "deleted_at"),
        ("name", "name"),
        ("description", "description"),
        ("color", "color"),
        ("icon", "icon"),
        ("kind", "kind"),
        ("type", "type"),
        ("filterRules", "filter_rules"),
        ("linkedListId", "linked_list_id"),
    ],
    defaults: r#"{"color":"bg-blue-500","icon":"List","type":"static"}"#,
};

/// `parties` (`schema.parties`): Drizzle key and column of each field.
pub const PARTIES: Table = Table {
    name: "parties",
    columns: &[
        ("id", "id"),
        ("createdAt", "created_at"),
        ("updatedAt", "updated_at"),
        ("deletedAt", "deleted_at"),
        ("version", "version"),
        ("partyCode", "party_code"),
        ("kind", "kind"),
        ("companyId", "company_id"),
        ("personId", "person_id"),
        ("displayName", "display_name"),
        ("ownerId", "owner_id"),
        ("accountManagerId", "account_manager_id"),
        ("status", "status"),
        ("parentPartyId", "parent_party_id"),
        ("isKeyAccount", "is_key_account"),
        ("billingAddress", "billing_address"),
        ("shippingAddress", "shipping_address"),
        ("creditLimit", "credit_limit"),
        ("paymentTerms", "payment_terms"),
        ("taxExempt", "tax_exempt"),
        ("currency", "currency"),
        ("iban", "iban"),
        ("bic", "bic"),
        ("defaultRevenueAccountId", "default_revenue_account_id"),
        ("defaultExpenseAccountId", "default_expense_account_id"),
        ("outstandingBalance", "outstanding_balance"),
        ("sepaMandate", "sepa_mandate"),
        ("relationshipSince", "relationship_since"),
        ("churnedAt", "churned_at"),
        ("churnReason", "churn_reason"),
        ("contractRenewalDate", "contract_renewal_date"),
        ("totalOpportunities", "total_opportunities"),
        ("wonOpportunities", "won_opportunities"),
        ("totalRevenue", "total_revenue"),
        ("lifetimeValue", "lifetime_value"),
        ("averageDealSize", "average_deal_size"),
        ("totalOrders", "total_orders"),
        ("totalSpent", "total_spent"),
        ("archivedAt", "archived_at"),
        ("role", "role"),
        ("taxUse", "tax_use"),
        ("is1099Vendor", "is_1099_vendor"),
        ("default1099Form", "default_1099_form"),
        ("default1099Box", "default_1099_box"),
        ("tinType", "tin_type"),
        ("tinLast4", "tin_last4"),
        ("sensitiveEncrypted", "sensitive_encrypted"),
        ("w9", "w9"),
        ("backupWithholding", "backup_withholding"),
        ("brFiscal", "br_fiscal"),
        ("tinMatchStatus", "tin_match_status"),
        ("tinMatchedAt", "tin_matched_at"),
        (
            "form1099EDeliveryConsentAt",
            "form_1099_e_delivery_consent_at",
        ),
        ("achRoutingNumber", "ach_routing_number"),
        ("achAccountLast4", "ach_account_last4"),
        ("achAccountType", "ach_account_type"),
        ("bankDetailsChangedAt", "bank_details_changed_at"),
        ("bankDetailsVerifiedAt", "bank_details_verified_at"),
        ("bankDetailsVerifiedBy", "bank_details_verified_by"),
    ],
    defaults: r#"{"version":1,"status":"active","is_key_account":false,"tax_exempt":false,"outstanding_balance":"0","total_opportunities":0,"won_opportunities":0,"total_orders":0,"role":"customer","is_1099_vendor":false,"backup_withholding":false}"#,
};

/// `people` (`schema.people`): Drizzle key and column of each field.
pub const PEOPLE: Table = Table {
    name: "people",
    columns: &[
        ("id", "id"),
        ("createdAt", "created_at"),
        ("updatedAt", "updated_at"),
        ("deletedAt", "deleted_at"),
        ("version", "version"),
        ("firstName", "first_name"),
        ("lastName", "last_name"),
        ("fullName", "full_name"),
        ("displayName", "display_name"),
        ("dateOfBirth", "date_of_birth"),
        ("gender", "gender"),
        ("title", "title"),
        ("department", "department"),
        ("role", "role"),
        ("email", "email"),
        ("alternateEmails", "alternate_emails"),
        ("directPhone", "direct_phone"),
        ("mobilePhone", "mobile_phone"),
        ("extension", "extension"),
        ("primaryAddress", "primary_address"),
        ("addresses", "addresses"),
        ("avatarUrl", "avatar_url"),
        ("linkedinUrl", "linkedin_url"),
        ("twitterHandle", "twitter_handle"),
        ("ownerId", "owner_id"),
        ("accountManagerId", "account_manager_id"),
        ("status", "status"),
        ("lifecycleStage", "lifecycle_stage"),
        ("rating", "rating"),
        ("source", "source"),
        ("isSupplier", "is_supplier"),
        ("isLead", "is_lead"),
        ("isFavorite", "is_favorite"),
        ("inCrm", "in_crm"),
        ("isDecisionMaker", "is_decision_maker"),
        ("isBillingContact", "is_billing_contact"),
        ("isTechnicalContact", "is_technical_contact"),
        ("influenceLevel", "influence_level"),
        ("leadScore", "lead_score"),
        ("npsScore", "nps_score"),
        ("satisfactionScore", "satisfaction_score"),
        ("firstContactDate", "first_contact_date"),
        ("lastContactDate", "last_contact_date"),
        ("lastContactedAt", "last_contacted_at"),
        ("nextFollowUpDate", "next_follow_up_date"),
        ("lastActivityType", "last_activity_type"),
        ("preferredContactMethod", "preferred_contact_method"),
        ("preferredLanguage", "preferred_language"),
        ("bestTimeToContact", "best_time_to_contact"),
        ("marketingConsent", "marketing_consent"),
        ("emailOptIn", "email_opt_in"),
        ("smsOptIn", "sms_opt_in"),
        ("doNotCall", "do_not_call"),
        ("tags", "tags"),
        ("interests", "interests"),
        ("customFields", "custom_fields"),
        ("notes", "notes"),
        ("internalNotes", "internal_notes"),
        ("partyCode", "party_code"),
        ("visitorId", "visitor_id"),
        ("archivedAt", "archived_at"),
    ],
    defaults: r#"{"version":1,"status":"active","is_supplier":false,"is_lead":false,"is_favorite":false,"in_crm":true,"is_decision_maker":false,"is_billing_contact":false,"is_technical_contact":false,"lead_score":0,"marketing_consent":false,"email_opt_in":false,"sms_opt_in":false,"do_not_call":false}"#,
};

/// `person_companies` (`schema.personCompanies`): Drizzle key and column of each field.
pub const PERSON_COMPANIES: Table = Table {
    name: "person_companies",
    columns: &[
        ("id", "id"),
        ("createdAt", "created_at"),
        ("updatedAt", "updated_at"),
        ("personId", "person_id"),
        ("companyId", "company_id"),
        ("role", "role"),
        ("isPrimary", "is_primary"),
        ("startedAt", "started_at"),
        ("endedAt", "ended_at"),
    ],
    defaults: r#"{"is_primary":false}"#,
};

/// `sequence_enrollments` (`schema.sequenceEnrollments`): Drizzle key and column of each field.
pub const SEQUENCE_ENROLLMENTS: Table = Table {
    name: "sequence_enrollments",
    columns: &[
        ("id", "id"),
        ("sequenceId", "sequence_id"),
        ("customerId", "customer_id"),
        ("counterpartyId", "counterparty_id"),
        ("status", "status"),
        ("executionId", "execution_id"),
        ("currentStepIndex", "current_step_index"),
        ("totalSteps", "total_steps"),
        ("enrolledBy", "enrolled_by"),
        ("enrolledAt", "enrolled_at"),
        ("completedAt", "completed_at"),
        ("pausedAt", "paused_at"),
        ("unenrolledAt", "unenrolled_at"),
        ("failedAt", "failed_at"),
        ("errorMessage", "error_message"),
        ("customerSnapshot", "customer_snapshot"),
    ],
    defaults: r#"{"status":"active","current_step_index":0,"total_steps":0}"#,
};

/// `workflows` (`schema.workflows`): Drizzle key and column of each field.
pub const WORKFLOWS: Table = Table {
    name: "workflows",
    columns: &[
        ("id", "id"),
        ("createdAt", "created_at"),
        ("updatedAt", "updated_at"),
        ("deletedAt", "deleted_at"),
        ("name", "name"),
        ("description", "description"),
        ("status", "status"),
        ("version", "version"),
        ("triggers", "triggers"),
        ("steps", "steps"),
        ("settings", "settings"),
        ("createdBy", "created_by"),
        ("folderId", "folder_id"),
        ("tags", "tags"),
        ("executionCount", "execution_count"),
        ("successCount", "success_count"),
        ("failureCount", "failure_count"),
        ("averageExecutionTime", "average_execution_time"),
        ("lastExecutedAt", "last_executed_at"),
        ("templateId", "template_id"),
    ],
    defaults: r#"{"status":"draft","version":1,"execution_count":0,"success_count":0,"failure_count":0}"#,
};

/// `insert into <table> (…) select … from jsonb_populate_record(null::<table>, $1)`.
#[macro_export]
macro_rules! insert_sql {
    (companies) => {
        "insert into companies (id, created_at, updated_at, deleted_at, version, name, trading_name, display_name, registration_number, vat_number, industry, employee_count, annual_revenue, funding_raised, foundation_date, description, website, email, alternate_emails, phone, mobile, fax, primary_address, addresses, avatar_url, linkedin_url, twitter_handle, facebook_url, instagram_url, angellist_url, twitter_follower_count, created_by, owner_id, account_manager_id, status, lifecycle_stage, segment, rating, source, is_supplier, is_lead, is_favorite, lead_score, nps_score, satisfaction_score, first_contact_date, last_contact_date, next_follow_up_date, preferred_contact_method, preferred_language, timezone, marketing_consent, email_opt_in, sms_opt_in, do_not_call, tags, custom_fields, notes, internal_notes, party_code, archived_at) select id, created_at, updated_at, deleted_at, version, name, trading_name, display_name, registration_number, vat_number, industry, employee_count, annual_revenue, funding_raised, foundation_date, description, website, email, alternate_emails, phone, mobile, fax, primary_address, addresses, avatar_url, linkedin_url, twitter_handle, facebook_url, instagram_url, angellist_url, twitter_follower_count, created_by, owner_id, account_manager_id, status, lifecycle_stage, segment, rating, source, is_supplier, is_lead, is_favorite, lead_score, nps_score, satisfaction_score, first_contact_date, last_contact_date, next_follow_up_date, preferred_contact_method, preferred_language, timezone, marketing_consent, email_opt_in, sms_opt_in, do_not_call, tags, custom_fields, notes, internal_notes, party_code, archived_at from jsonb_populate_record(null::companies, $1::jsonb)"
    };
    (crm_activities) => {
        "insert into crm_activities (id, created_at, updated_at, deleted_at, type, subject, description, related_to, related_to_id, related_to_name, customer_id, contact_id, counterparty_id, person_id, lead_id, opportunity_id, assigned_to_id, due_date, start_time, end_time, duration, status, priority, location, is_virtual, meeting_url, call_direction, call_duration, call_recording_url, email_message_id, email_subject, email_from, email_to, email_cc, attendees, meeting_agenda, meeting_notes, outcome, next_action, follow_up_date, attachments, calendar_event_id, is_favorite, tags, custom_fields, labels, assignee_ids, repeat, change_log) select id, created_at, updated_at, deleted_at, type, subject, description, related_to, related_to_id, related_to_name, customer_id, contact_id, counterparty_id, person_id, lead_id, opportunity_id, assigned_to_id, due_date, start_time, end_time, duration, status, priority, location, is_virtual, meeting_url, call_direction, call_duration, call_recording_url, email_message_id, email_subject, email_from, email_to, email_cc, attendees, meeting_agenda, meeting_notes, outcome, next_action, follow_up_date, attachments, calendar_event_id, is_favorite, tags, custom_fields, labels, assignee_ids, repeat, change_log from jsonb_populate_record(null::crm_activities, $1::jsonb)"
    };
    (crm_customer_statuses) => {
        "insert into crm_customer_statuses (id, created_at, updated_at, deleted_at, name, slug, color, sort_order) select id, created_at, updated_at, deleted_at, name, slug, color, sort_order from jsonb_populate_record(null::crm_customer_statuses, $1::jsonb)"
    };
    (crm_leads) => {
        "insert into crm_leads (id, created_at, updated_at, deleted_at, first_name, last_name, full_name, company_name, title, email, phone, mobile, website, address, source, channel, campaign, medium, status, rating, score, owner_id, assigned_at, is_qualified, qualified_at, disqualified_reason, product_interest, budget, timeline, authority, need, converted_at, converted_to_customer_id, converted_to_counterparty_id, converted_to_opportunity_id, first_response_at, last_activity_at, number_of_touches, notes, next_action) select id, created_at, updated_at, deleted_at, first_name, last_name, full_name, company_name, title, email, phone, mobile, website, address, source, channel, campaign, medium, status, rating, score, owner_id, assigned_at, is_qualified, qualified_at, disqualified_reason, product_interest, budget, timeline, authority, need, converted_at, converted_to_customer_id, converted_to_counterparty_id, converted_to_opportunity_id, first_response_at, last_activity_at, number_of_touches, notes, next_action from jsonb_populate_record(null::crm_leads, $1::jsonb)"
    };
    (crm_opportunities) => {
        "insert into crm_opportunities (id, created_at, updated_at, deleted_at, name, description, customer_id, customer_name, contact_ids, primary_contact_id, counterparty_id, person_ids, primary_person_id, amount, currency, expected_revenue, recurring_revenue, contract_length, stage_id, stage, probability, pipeline, sales_process, close_date, actual_close_date, start_date, competitors, competition_status, win_loss_reason, line_items, owner_id, team_members, lead_source, campaign, type, category, status, forecast_category, next_step, next_step_date, risk_level, risk_reason, proposal_url, contract_url, attachments, last_activity_date, days_in_current_stage, total_activities, custom_fields, tags) select id, created_at, updated_at, deleted_at, name, description, customer_id, customer_name, contact_ids, primary_contact_id, counterparty_id, person_ids, primary_person_id, amount, currency, expected_revenue, recurring_revenue, contract_length, stage_id, stage, probability, pipeline, sales_process, close_date, actual_close_date, start_date, competitors, competition_status, win_loss_reason, line_items, owner_id, team_members, lead_source, campaign, type, category, status, forecast_category, next_step, next_step_date, risk_level, risk_reason, proposal_url, contract_url, attachments, last_activity_date, days_in_current_stage, total_activities, custom_fields, tags from jsonb_populate_record(null::crm_opportunities, $1::jsonb)"
    };
    (crm_pipeline_stages) => {
        "insert into crm_pipeline_stages (id, created_at, updated_at, deleted_at, name, description, position, probability, color, pipeline, is_default, is_won, is_lost) select id, created_at, updated_at, deleted_at, name, description, position, probability, color, pipeline, is_default, is_won, is_lost from jsonb_populate_record(null::crm_pipeline_stages, $1::jsonb)"
    };
    (crm_pipelines) => {
        "insert into crm_pipelines (id, created_at, updated_at, deleted_at, name, description, icon, color, template, settings, is_default, is_archived) select id, created_at, updated_at, deleted_at, name, description, icon, color, template, settings, is_default, is_archived from jsonb_populate_record(null::crm_pipelines, $1::jsonb)"
    };
    (custom_field_definitions) => {
        "insert into custom_field_definitions (id, created_at, updated_at, deleted_at, entity_type, name, slug, description, field_type, options, config, required, sort_order, group, ticket_type_id) select id, created_at, updated_at, deleted_at, entity_type, name, slug, description, field_type, options, config, required, sort_order, group, ticket_type_id from jsonb_populate_record(null::custom_field_definitions, $1::jsonb)"
    };
    (custom_field_values) => {
        "insert into custom_field_values (id, created_at, updated_at, field_id, entity_type, entity_id, value_text, value_number, value_date, value_bool, value_json, value_ref) select id, created_at, updated_at, field_id, entity_type, entity_id, value_text, value_number, value_date, value_bool, value_json, value_ref from jsonb_populate_record(null::custom_field_values, $1::jsonb)"
    };
    (list_members) => {
        "insert into list_members (id, added_at, added_by, list_id, entity_id) select id, added_at, added_by, list_id, entity_id from jsonb_populate_record(null::list_members, $1::jsonb)"
    };
    (lists) => {
        "insert into lists (id, created_at, updated_at, deleted_at, name, description, color, icon, kind, type, filter_rules, linked_list_id) select id, created_at, updated_at, deleted_at, name, description, color, icon, kind, type, filter_rules, linked_list_id from jsonb_populate_record(null::lists, $1::jsonb)"
    };
    (parties) => {
        "insert into parties (id, created_at, updated_at, deleted_at, version, party_code, kind, company_id, person_id, display_name, owner_id, account_manager_id, status, parent_party_id, is_key_account, billing_address, shipping_address, credit_limit, payment_terms, tax_exempt, currency, iban, bic, default_revenue_account_id, default_expense_account_id, outstanding_balance, sepa_mandate, relationship_since, churned_at, churn_reason, contract_renewal_date, total_opportunities, won_opportunities, total_revenue, lifetime_value, average_deal_size, total_orders, total_spent, archived_at, role, tax_use, is_1099_vendor, default_1099_form, default_1099_box, tin_type, tin_last4, sensitive_encrypted, w9, backup_withholding, br_fiscal, tin_match_status, tin_matched_at, form_1099_e_delivery_consent_at, ach_routing_number, ach_account_last4, ach_account_type, bank_details_changed_at, bank_details_verified_at, bank_details_verified_by) select id, created_at, updated_at, deleted_at, version, party_code, kind, company_id, person_id, display_name, owner_id, account_manager_id, status, parent_party_id, is_key_account, billing_address, shipping_address, credit_limit, payment_terms, tax_exempt, currency, iban, bic, default_revenue_account_id, default_expense_account_id, outstanding_balance, sepa_mandate, relationship_since, churned_at, churn_reason, contract_renewal_date, total_opportunities, won_opportunities, total_revenue, lifetime_value, average_deal_size, total_orders, total_spent, archived_at, role, tax_use, is_1099_vendor, default_1099_form, default_1099_box, tin_type, tin_last4, sensitive_encrypted, w9, backup_withholding, br_fiscal, tin_match_status, tin_matched_at, form_1099_e_delivery_consent_at, ach_routing_number, ach_account_last4, ach_account_type, bank_details_changed_at, bank_details_verified_at, bank_details_verified_by from jsonb_populate_record(null::parties, $1::jsonb)"
    };
    (people) => {
        "insert into people (id, created_at, updated_at, deleted_at, version, first_name, last_name, full_name, display_name, date_of_birth, gender, title, department, role, email, alternate_emails, direct_phone, mobile_phone, extension, primary_address, addresses, avatar_url, linkedin_url, twitter_handle, owner_id, account_manager_id, status, lifecycle_stage, rating, source, is_supplier, is_lead, is_favorite, in_crm, is_decision_maker, is_billing_contact, is_technical_contact, influence_level, lead_score, nps_score, satisfaction_score, first_contact_date, last_contact_date, last_contacted_at, next_follow_up_date, last_activity_type, preferred_contact_method, preferred_language, best_time_to_contact, marketing_consent, email_opt_in, sms_opt_in, do_not_call, tags, interests, custom_fields, notes, internal_notes, party_code, visitor_id, archived_at) select id, created_at, updated_at, deleted_at, version, first_name, last_name, full_name, display_name, date_of_birth, gender, title, department, role, email, alternate_emails, direct_phone, mobile_phone, extension, primary_address, addresses, avatar_url, linkedin_url, twitter_handle, owner_id, account_manager_id, status, lifecycle_stage, rating, source, is_supplier, is_lead, is_favorite, in_crm, is_decision_maker, is_billing_contact, is_technical_contact, influence_level, lead_score, nps_score, satisfaction_score, first_contact_date, last_contact_date, last_contacted_at, next_follow_up_date, last_activity_type, preferred_contact_method, preferred_language, best_time_to_contact, marketing_consent, email_opt_in, sms_opt_in, do_not_call, tags, interests, custom_fields, notes, internal_notes, party_code, visitor_id, archived_at from jsonb_populate_record(null::people, $1::jsonb)"
    };
    (person_companies) => {
        "insert into person_companies (id, created_at, updated_at, person_id, company_id, role, is_primary, started_at, ended_at) select id, created_at, updated_at, person_id, company_id, role, is_primary, started_at, ended_at from jsonb_populate_record(null::person_companies, $1::jsonb)"
    };
    (sequence_enrollments) => {
        "insert into sequence_enrollments (id, sequence_id, customer_id, counterparty_id, status, execution_id, current_step_index, total_steps, enrolled_by, enrolled_at, completed_at, paused_at, unenrolled_at, failed_at, error_message, customer_snapshot) select id, sequence_id, customer_id, counterparty_id, status, execution_id, current_step_index, total_steps, enrolled_by, enrolled_at, completed_at, paused_at, unenrolled_at, failed_at, error_message, customer_snapshot from jsonb_populate_record(null::sequence_enrollments, $1::jsonb)"
    };
    (workflows) => {
        "insert into workflows (id, created_at, updated_at, deleted_at, name, description, status, version, triggers, steps, settings, created_by, folder_id, tags, execution_count, success_count, failure_count, average_execution_time, last_executed_at, template_id) select id, created_at, updated_at, deleted_at, name, description, status, version, triggers, steps, settings, created_by, folder_id, tags, execution_count, success_count, failure_count, average_execution_time, last_executed_at, template_id from jsonb_populate_record(null::workflows, $1::jsonb)"
    };
}

/// `update <table> t set (…) = (select … from jsonb_populate_record(t, $2) r) <tail>`:
/// `$2` is the JSON of the columns to change; `tail` is the `where` clause.
#[macro_export]
macro_rules! update_sql {
    (companies, $tail:literal) => {
        concat!("update companies t set (created_at, updated_at, deleted_at, version, name, trading_name, display_name, registration_number, vat_number, industry, employee_count, annual_revenue, funding_raised, foundation_date, description, website, email, alternate_emails, phone, mobile, fax, primary_address, addresses, avatar_url, linkedin_url, twitter_handle, facebook_url, instagram_url, angellist_url, twitter_follower_count, created_by, owner_id, account_manager_id, status, lifecycle_stage, segment, rating, source, is_supplier, is_lead, is_favorite, lead_score, nps_score, satisfaction_score, first_contact_date, last_contact_date, next_follow_up_date, preferred_contact_method, preferred_language, timezone, marketing_consent, email_opt_in, sms_opt_in, do_not_call, tags, custom_fields, notes, internal_notes, party_code, archived_at) = (select r.created_at, r.updated_at, r.deleted_at, r.version, r.name, r.trading_name, r.display_name, r.registration_number, r.vat_number, r.industry, r.employee_count, r.annual_revenue, r.funding_raised, r.foundation_date, r.description, r.website, r.email, r.alternate_emails, r.phone, r.mobile, r.fax, r.primary_address, r.addresses, r.avatar_url, r.linkedin_url, r.twitter_handle, r.facebook_url, r.instagram_url, r.angellist_url, r.twitter_follower_count, r.created_by, r.owner_id, r.account_manager_id, r.status, r.lifecycle_stage, r.segment, r.rating, r.source, r.is_supplier, r.is_lead, r.is_favorite, r.lead_score, r.nps_score, r.satisfaction_score, r.first_contact_date, r.last_contact_date, r.next_follow_up_date, r.preferred_contact_method, r.preferred_language, r.timezone, r.marketing_consent, r.email_opt_in, r.sms_opt_in, r.do_not_call, r.tags, r.custom_fields, r.notes, r.internal_notes, r.party_code, r.archived_at from jsonb_populate_record(t, $2::jsonb) r) ", $tail)
    };
    (crm_activities, $tail:literal) => {
        concat!("update crm_activities t set (created_at, updated_at, deleted_at, type, subject, description, related_to, related_to_id, related_to_name, customer_id, contact_id, counterparty_id, person_id, lead_id, opportunity_id, assigned_to_id, due_date, start_time, end_time, duration, status, priority, location, is_virtual, meeting_url, call_direction, call_duration, call_recording_url, email_message_id, email_subject, email_from, email_to, email_cc, attendees, meeting_agenda, meeting_notes, outcome, next_action, follow_up_date, attachments, calendar_event_id, is_favorite, tags, custom_fields, labels, assignee_ids, repeat, change_log) = (select r.created_at, r.updated_at, r.deleted_at, r.type, r.subject, r.description, r.related_to, r.related_to_id, r.related_to_name, r.customer_id, r.contact_id, r.counterparty_id, r.person_id, r.lead_id, r.opportunity_id, r.assigned_to_id, r.due_date, r.start_time, r.end_time, r.duration, r.status, r.priority, r.location, r.is_virtual, r.meeting_url, r.call_direction, r.call_duration, r.call_recording_url, r.email_message_id, r.email_subject, r.email_from, r.email_to, r.email_cc, r.attendees, r.meeting_agenda, r.meeting_notes, r.outcome, r.next_action, r.follow_up_date, r.attachments, r.calendar_event_id, r.is_favorite, r.tags, r.custom_fields, r.labels, r.assignee_ids, r.repeat, r.change_log from jsonb_populate_record(t, $2::jsonb) r) ", $tail)
    };
    (crm_customer_statuses, $tail:literal) => {
        concat!("update crm_customer_statuses t set (created_at, updated_at, deleted_at, name, slug, color, sort_order) = (select r.created_at, r.updated_at, r.deleted_at, r.name, r.slug, r.color, r.sort_order from jsonb_populate_record(t, $2::jsonb) r) ", $tail)
    };
    (crm_leads, $tail:literal) => {
        concat!("update crm_leads t set (created_at, updated_at, deleted_at, first_name, last_name, full_name, company_name, title, email, phone, mobile, website, address, source, channel, campaign, medium, status, rating, score, owner_id, assigned_at, is_qualified, qualified_at, disqualified_reason, product_interest, budget, timeline, authority, need, converted_at, converted_to_customer_id, converted_to_counterparty_id, converted_to_opportunity_id, first_response_at, last_activity_at, number_of_touches, notes, next_action) = (select r.created_at, r.updated_at, r.deleted_at, r.first_name, r.last_name, r.full_name, r.company_name, r.title, r.email, r.phone, r.mobile, r.website, r.address, r.source, r.channel, r.campaign, r.medium, r.status, r.rating, r.score, r.owner_id, r.assigned_at, r.is_qualified, r.qualified_at, r.disqualified_reason, r.product_interest, r.budget, r.timeline, r.authority, r.need, r.converted_at, r.converted_to_customer_id, r.converted_to_counterparty_id, r.converted_to_opportunity_id, r.first_response_at, r.last_activity_at, r.number_of_touches, r.notes, r.next_action from jsonb_populate_record(t, $2::jsonb) r) ", $tail)
    };
    (crm_opportunities, $tail:literal) => {
        concat!("update crm_opportunities t set (created_at, updated_at, deleted_at, name, description, customer_id, customer_name, contact_ids, primary_contact_id, counterparty_id, person_ids, primary_person_id, amount, currency, expected_revenue, recurring_revenue, contract_length, stage_id, stage, probability, pipeline, sales_process, close_date, actual_close_date, start_date, competitors, competition_status, win_loss_reason, line_items, owner_id, team_members, lead_source, campaign, type, category, status, forecast_category, next_step, next_step_date, risk_level, risk_reason, proposal_url, contract_url, attachments, last_activity_date, days_in_current_stage, total_activities, custom_fields, tags) = (select r.created_at, r.updated_at, r.deleted_at, r.name, r.description, r.customer_id, r.customer_name, r.contact_ids, r.primary_contact_id, r.counterparty_id, r.person_ids, r.primary_person_id, r.amount, r.currency, r.expected_revenue, r.recurring_revenue, r.contract_length, r.stage_id, r.stage, r.probability, r.pipeline, r.sales_process, r.close_date, r.actual_close_date, r.start_date, r.competitors, r.competition_status, r.win_loss_reason, r.line_items, r.owner_id, r.team_members, r.lead_source, r.campaign, r.type, r.category, r.status, r.forecast_category, r.next_step, r.next_step_date, r.risk_level, r.risk_reason, r.proposal_url, r.contract_url, r.attachments, r.last_activity_date, r.days_in_current_stage, r.total_activities, r.custom_fields, r.tags from jsonb_populate_record(t, $2::jsonb) r) ", $tail)
    };
    (crm_pipeline_stages, $tail:literal) => {
        concat!("update crm_pipeline_stages t set (created_at, updated_at, deleted_at, name, description, position, probability, color, pipeline, is_default, is_won, is_lost) = (select r.created_at, r.updated_at, r.deleted_at, r.name, r.description, r.position, r.probability, r.color, r.pipeline, r.is_default, r.is_won, r.is_lost from jsonb_populate_record(t, $2::jsonb) r) ", $tail)
    };
    (crm_pipelines, $tail:literal) => {
        concat!("update crm_pipelines t set (created_at, updated_at, deleted_at, name, description, icon, color, template, settings, is_default, is_archived) = (select r.created_at, r.updated_at, r.deleted_at, r.name, r.description, r.icon, r.color, r.template, r.settings, r.is_default, r.is_archived from jsonb_populate_record(t, $2::jsonb) r) ", $tail)
    };
    (custom_field_definitions, $tail:literal) => {
        concat!("update custom_field_definitions t set (created_at, updated_at, deleted_at, entity_type, name, slug, description, field_type, options, config, required, sort_order, group, ticket_type_id) = (select r.created_at, r.updated_at, r.deleted_at, r.entity_type, r.name, r.slug, r.description, r.field_type, r.options, r.config, r.required, r.sort_order, r.group, r.ticket_type_id from jsonb_populate_record(t, $2::jsonb) r) ", $tail)
    };
    (custom_field_values, $tail:literal) => {
        concat!("update custom_field_values t set (created_at, updated_at, field_id, entity_type, entity_id, value_text, value_number, value_date, value_bool, value_json, value_ref) = (select r.created_at, r.updated_at, r.field_id, r.entity_type, r.entity_id, r.value_text, r.value_number, r.value_date, r.value_bool, r.value_json, r.value_ref from jsonb_populate_record(t, $2::jsonb) r) ", $tail)
    };
    (list_members, $tail:literal) => {
        concat!("update list_members t set (added_at, added_by, list_id, entity_id) = (select r.added_at, r.added_by, r.list_id, r.entity_id from jsonb_populate_record(t, $2::jsonb) r) ", $tail)
    };
    (lists, $tail:literal) => {
        concat!("update lists t set (created_at, updated_at, deleted_at, name, description, color, icon, kind, type, filter_rules, linked_list_id) = (select r.created_at, r.updated_at, r.deleted_at, r.name, r.description, r.color, r.icon, r.kind, r.type, r.filter_rules, r.linked_list_id from jsonb_populate_record(t, $2::jsonb) r) ", $tail)
    };
    (parties, $tail:literal) => {
        concat!("update parties t set (created_at, updated_at, deleted_at, version, party_code, kind, company_id, person_id, display_name, owner_id, account_manager_id, status, parent_party_id, is_key_account, billing_address, shipping_address, credit_limit, payment_terms, tax_exempt, currency, iban, bic, default_revenue_account_id, default_expense_account_id, outstanding_balance, sepa_mandate, relationship_since, churned_at, churn_reason, contract_renewal_date, total_opportunities, won_opportunities, total_revenue, lifetime_value, average_deal_size, total_orders, total_spent, archived_at, role, tax_use, is_1099_vendor, default_1099_form, default_1099_box, tin_type, tin_last4, sensitive_encrypted, w9, backup_withholding, br_fiscal, tin_match_status, tin_matched_at, form_1099_e_delivery_consent_at, ach_routing_number, ach_account_last4, ach_account_type, bank_details_changed_at, bank_details_verified_at, bank_details_verified_by) = (select r.created_at, r.updated_at, r.deleted_at, r.version, r.party_code, r.kind, r.company_id, r.person_id, r.display_name, r.owner_id, r.account_manager_id, r.status, r.parent_party_id, r.is_key_account, r.billing_address, r.shipping_address, r.credit_limit, r.payment_terms, r.tax_exempt, r.currency, r.iban, r.bic, r.default_revenue_account_id, r.default_expense_account_id, r.outstanding_balance, r.sepa_mandate, r.relationship_since, r.churned_at, r.churn_reason, r.contract_renewal_date, r.total_opportunities, r.won_opportunities, r.total_revenue, r.lifetime_value, r.average_deal_size, r.total_orders, r.total_spent, r.archived_at, r.role, r.tax_use, r.is_1099_vendor, r.default_1099_form, r.default_1099_box, r.tin_type, r.tin_last4, r.sensitive_encrypted, r.w9, r.backup_withholding, r.br_fiscal, r.tin_match_status, r.tin_matched_at, r.form_1099_e_delivery_consent_at, r.ach_routing_number, r.ach_account_last4, r.ach_account_type, r.bank_details_changed_at, r.bank_details_verified_at, r.bank_details_verified_by from jsonb_populate_record(t, $2::jsonb) r) ", $tail)
    };
    (people, $tail:literal) => {
        concat!("update people t set (created_at, updated_at, deleted_at, version, first_name, last_name, full_name, display_name, date_of_birth, gender, title, department, role, email, alternate_emails, direct_phone, mobile_phone, extension, primary_address, addresses, avatar_url, linkedin_url, twitter_handle, owner_id, account_manager_id, status, lifecycle_stage, rating, source, is_supplier, is_lead, is_favorite, in_crm, is_decision_maker, is_billing_contact, is_technical_contact, influence_level, lead_score, nps_score, satisfaction_score, first_contact_date, last_contact_date, last_contacted_at, next_follow_up_date, last_activity_type, preferred_contact_method, preferred_language, best_time_to_contact, marketing_consent, email_opt_in, sms_opt_in, do_not_call, tags, interests, custom_fields, notes, internal_notes, party_code, visitor_id, archived_at) = (select r.created_at, r.updated_at, r.deleted_at, r.version, r.first_name, r.last_name, r.full_name, r.display_name, r.date_of_birth, r.gender, r.title, r.department, r.role, r.email, r.alternate_emails, r.direct_phone, r.mobile_phone, r.extension, r.primary_address, r.addresses, r.avatar_url, r.linkedin_url, r.twitter_handle, r.owner_id, r.account_manager_id, r.status, r.lifecycle_stage, r.rating, r.source, r.is_supplier, r.is_lead, r.is_favorite, r.in_crm, r.is_decision_maker, r.is_billing_contact, r.is_technical_contact, r.influence_level, r.lead_score, r.nps_score, r.satisfaction_score, r.first_contact_date, r.last_contact_date, r.last_contacted_at, r.next_follow_up_date, r.last_activity_type, r.preferred_contact_method, r.preferred_language, r.best_time_to_contact, r.marketing_consent, r.email_opt_in, r.sms_opt_in, r.do_not_call, r.tags, r.interests, r.custom_fields, r.notes, r.internal_notes, r.party_code, r.visitor_id, r.archived_at from jsonb_populate_record(t, $2::jsonb) r) ", $tail)
    };
    (person_companies, $tail:literal) => {
        concat!("update person_companies t set (created_at, updated_at, person_id, company_id, role, is_primary, started_at, ended_at) = (select r.created_at, r.updated_at, r.person_id, r.company_id, r.role, r.is_primary, r.started_at, r.ended_at from jsonb_populate_record(t, $2::jsonb) r) ", $tail)
    };
    (sequence_enrollments, $tail:literal) => {
        concat!("update sequence_enrollments t set (sequence_id, customer_id, counterparty_id, status, execution_id, current_step_index, total_steps, enrolled_by, enrolled_at, completed_at, paused_at, unenrolled_at, failed_at, error_message, customer_snapshot) = (select r.sequence_id, r.customer_id, r.counterparty_id, r.status, r.execution_id, r.current_step_index, r.total_steps, r.enrolled_by, r.enrolled_at, r.completed_at, r.paused_at, r.unenrolled_at, r.failed_at, r.error_message, r.customer_snapshot from jsonb_populate_record(t, $2::jsonb) r) ", $tail)
    };
    (workflows, $tail:literal) => {
        concat!("update workflows t set (created_at, updated_at, deleted_at, name, description, status, version, triggers, steps, settings, created_by, folder_id, tags, execution_count, success_count, failure_count, average_execution_time, last_executed_at, template_id) = (select r.created_at, r.updated_at, r.deleted_at, r.name, r.description, r.status, r.version, r.triggers, r.steps, r.settings, r.created_by, r.folder_id, r.tags, r.execution_count, r.success_count, r.failure_count, r.average_execution_time, r.last_executed_at, r.template_id from jsonb_populate_record(t, $2::jsonb) r) ", $tail)
    };
}
