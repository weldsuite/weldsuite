//! `people`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "people")]
pub struct Model {
    #[sea_orm(
        primary_key,
        auto_increment = false,
        column_type = "String(StringLen::N(30))"
    )]
    #[serde(rename = "id")]
    pub id: String,
    #[serde(rename = "createdAt", with = "crate::js::timestamp")]
    pub created_at: TimeDateTime,
    #[serde(rename = "updatedAt", with = "crate::js::timestamp")]
    pub updated_at: TimeDateTime,
    #[serde(rename = "deletedAt", with = "crate::js::timestamp::option")]
    pub deleted_at: Option<TimeDateTime>,
    #[serde(rename = "version")]
    pub version: i32,
    #[sea_orm(column_type = "String(StringLen::N(100))")]
    #[serde(rename = "firstName")]
    pub first_name: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(100))")]
    #[serde(rename = "lastName")]
    pub last_name: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "fullName")]
    pub full_name: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "displayName")]
    pub display_name: String,
    #[serde(rename = "dateOfBirth", with = "crate::js::timestamp::option")]
    pub date_of_birth: Option<TimeDateTime>,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "gender")]
    pub gender: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(100))")]
    #[serde(rename = "title")]
    pub title: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(100))")]
    #[serde(rename = "department")]
    pub department: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "role")]
    pub role: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "email")]
    pub email: Option<String>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "alternateEmails")]
    pub alternate_emails: Option<Json>,
    #[sea_orm(column_type = "String(StringLen::N(50))")]
    #[serde(rename = "directPhone")]
    pub direct_phone: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(50))")]
    #[serde(rename = "mobilePhone")]
    pub mobile_phone: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "extension")]
    pub extension: Option<String>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "primaryAddress")]
    pub primary_address: Option<Json>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "addresses")]
    pub addresses: Option<Json>,
    #[sea_orm(column_type = "String(StringLen::N(1000))")]
    #[serde(rename = "avatarUrl")]
    pub avatar_url: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(500))")]
    #[serde(rename = "linkedinUrl")]
    pub linkedin_url: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(100))")]
    #[serde(rename = "twitterHandle")]
    pub twitter_handle: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "ownerId")]
    pub owner_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "accountManagerId")]
    pub account_manager_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "status")]
    pub status: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "lifecycleStage")]
    pub lifecycle_stage: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(10))")]
    #[serde(rename = "rating")]
    pub rating: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(100))")]
    #[serde(rename = "source")]
    pub source: Option<String>,
    #[serde(rename = "isSupplier")]
    pub is_supplier: bool,
    #[serde(rename = "isLead")]
    pub is_lead: bool,
    #[serde(rename = "isFavorite")]
    pub is_favorite: bool,
    #[serde(rename = "inCrm")]
    pub in_crm: bool,
    #[serde(rename = "isDecisionMaker")]
    pub is_decision_maker: Option<bool>,
    #[serde(rename = "isBillingContact")]
    pub is_billing_contact: Option<bool>,
    #[serde(rename = "isTechnicalContact")]
    pub is_technical_contact: Option<bool>,
    #[sea_orm(column_type = "String(StringLen::N(10))")]
    #[serde(rename = "influenceLevel")]
    pub influence_level: Option<String>,
    #[serde(rename = "leadScore")]
    pub lead_score: Option<i32>,
    #[serde(rename = "npsScore")]
    pub nps_score: Option<i32>,
    #[serde(rename = "satisfactionScore")]
    pub satisfaction_score: Option<i32>,
    #[serde(rename = "firstContactDate", with = "crate::js::timestamp::option")]
    pub first_contact_date: Option<TimeDateTime>,
    #[serde(rename = "lastContactDate", with = "crate::js::timestamp::option")]
    pub last_contact_date: Option<TimeDateTime>,
    #[serde(rename = "lastContactedAt", with = "crate::js::timestamp::option")]
    pub last_contacted_at: Option<TimeDateTime>,
    #[serde(rename = "nextFollowUpDate", with = "crate::js::timestamp::option")]
    pub next_follow_up_date: Option<TimeDateTime>,
    #[sea_orm(column_type = "String(StringLen::N(50))")]
    #[serde(rename = "lastActivityType")]
    pub last_activity_type: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "preferredContactMethod")]
    pub preferred_contact_method: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(10))")]
    #[serde(rename = "preferredLanguage")]
    pub preferred_language: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(100))")]
    #[serde(rename = "bestTimeToContact")]
    pub best_time_to_contact: Option<String>,
    #[serde(rename = "marketingConsent")]
    pub marketing_consent: Option<bool>,
    #[serde(rename = "emailOptIn")]
    pub email_opt_in: Option<bool>,
    #[serde(rename = "smsOptIn")]
    pub sms_opt_in: Option<bool>,
    #[serde(rename = "doNotCall")]
    pub do_not_call: Option<bool>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "tags")]
    pub tags: Option<Json>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "interests")]
    pub interests: Option<Json>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "customFields")]
    pub custom_fields: Option<Json>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "notes")]
    pub notes: Option<String>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "internalNotes")]
    pub internal_notes: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(50))")]
    #[serde(rename = "partyCode")]
    pub party_code: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(100))")]
    #[serde(rename = "visitorId")]
    pub visitor_id: Option<String>,
    #[serde(rename = "archivedAt", with = "crate::js::timestamp::option")]
    pub archived_at: Option<TimeDateTime>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "people",
    columns: &[
        DdlColumn {
            name: "created_at",
            sql_type: None,
            default: Some(DdlDefault::Sql("now()")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "updated_at",
            sql_type: None,
            default: Some(DdlDefault::Sql("now()")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "version",
            sql_type: None,
            default: Some(DdlDefault::Number("1")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "status",
            sql_type: None,
            default: Some(DdlDefault::Sql("'active'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "is_supplier",
            sql_type: None,
            default: Some(DdlDefault::Bool(false)),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "is_lead",
            sql_type: None,
            default: Some(DdlDefault::Bool(false)),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "is_favorite",
            sql_type: None,
            default: Some(DdlDefault::Bool(false)),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "in_crm",
            sql_type: None,
            default: Some(DdlDefault::Bool(true)),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "is_decision_maker",
            sql_type: None,
            default: Some(DdlDefault::Bool(false)),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "is_billing_contact",
            sql_type: None,
            default: Some(DdlDefault::Bool(false)),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "is_technical_contact",
            sql_type: None,
            default: Some(DdlDefault::Bool(false)),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "lead_score",
            sql_type: None,
            default: Some(DdlDefault::Number("0")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "marketing_consent",
            sql_type: None,
            default: Some(DdlDefault::Bool(false)),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "email_opt_in",
            sql_type: None,
            default: Some(DdlDefault::Bool(false)),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "sms_opt_in",
            sql_type: None,
            default: Some(DdlDefault::Bool(false)),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "do_not_call",
            sql_type: None,
            default: Some(DdlDefault::Bool(false)),
            generated: None,
            default_fn: false,
            on_update: false,
        },
    ],
    primary_key: None,
    indexes: &[
        Index {
            name: "people_email_idx",
            columns: &[IndexColumn {
                expression: "email",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "people_display_name_idx",
            columns: &[IndexColumn {
                expression: "display_name",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "people_status_idx",
            columns: &[IndexColumn {
                expression: "status",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "people_owner_idx",
            columns: &[IndexColumn {
                expression: "owner_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "people_party_code_idx",
            columns: &[IndexColumn {
                expression: "party_code",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "people_deleted_at_idx",
            columns: &[IndexColumn {
                expression: "deleted_at",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "people_is_supplier_idx",
            columns: &[IndexColumn {
                expression: "is_supplier",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "people_is_lead_idx",
            columns: &[IndexColumn {
                expression: "is_lead",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "people_in_crm_idx",
            columns: &[IndexColumn {
                expression: "in_crm",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "people_visitor_id_idx",
            columns: &[IndexColumn {
                expression: "visitor_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "people_live_created_idx",
            columns: &[
                IndexColumn {
                    expression: "created_at",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "id",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "in_crm",
                    is_expression: false,
                    asc: true,
                },
            ],
            unique: false,
            method: "btree",
            filter: Some("\"people\".\"deleted_at\" IS NULL"),
        },
        Index {
            name: "people_live_name_idx",
            columns: &[
                IndexColumn {
                    expression: "lower(\"display_name\"::text)",
                    is_expression: true,
                    asc: true,
                },
                IndexColumn {
                    expression: "id",
                    is_expression: false,
                    asc: true,
                },
            ],
            unique: false,
            method: "btree",
            filter: Some("\"people\".\"deleted_at\" IS NULL"),
        },
        Index {
            name: "people_search_trgm_idx",
            columns: &[IndexColumn {
                expression: "(coalesce(\"display_name\", '') || E'\\n' || coalesce(\"full_name\", '') || E'\\n' || coalesce(\"first_name\", '') || E'\\n' || coalesce(\"last_name\", '') || E'\\n' || coalesce(\"email\", '')) gin_trgm_ops",
                is_expression: true,
                asc: true,
            }],
            unique: false,
            method: "gin",
            filter: None,
        },
    ],
    foreign_keys: &[],
    uniques: &[
        Unique {
            name: "people_party_code_unique",
            columns: &["party_code"],
            nulls_not_distinct: false,
        },
        Unique {
            name: "people_visitor_id_unique",
            columns: &["visitor_id"],
            nulls_not_distinct: false,
        },
    ],
    checks: &[],
};
