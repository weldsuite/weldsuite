//! `crm_leads`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "crm_leads")]
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
    #[serde(rename = "companyName")]
    pub company_name: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(100))")]
    #[serde(rename = "title")]
    pub title: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "email")]
    pub email: String,
    #[sea_orm(column_type = "String(StringLen::N(50))")]
    #[serde(rename = "phone")]
    pub phone: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(50))")]
    #[serde(rename = "mobile")]
    pub mobile: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(500))")]
    #[serde(rename = "website")]
    pub website: Option<String>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "address")]
    pub address: Option<Json>,
    #[sea_orm(column_type = "String(StringLen::N(50))")]
    #[serde(rename = "source")]
    pub source: String,
    #[sea_orm(column_type = "String(StringLen::N(100))")]
    #[serde(rename = "channel")]
    pub channel: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "campaign")]
    pub campaign: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(100))")]
    #[serde(rename = "medium")]
    pub medium: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "status")]
    pub status: String,
    #[sea_orm(column_type = "String(StringLen::N(10))")]
    #[serde(rename = "rating")]
    pub rating: Option<String>,
    #[serde(rename = "score")]
    pub score: Option<i32>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "ownerId")]
    pub owner_id: Option<String>,
    #[serde(rename = "assignedAt", with = "crate::js::timestamp::option")]
    pub assigned_at: Option<TimeDateTime>,
    #[serde(rename = "isQualified")]
    pub is_qualified: Option<bool>,
    #[serde(rename = "qualifiedAt", with = "crate::js::timestamp::option")]
    pub qualified_at: Option<TimeDateTime>,
    #[sea_orm(column_type = "String(StringLen::N(500))")]
    #[serde(rename = "disqualifiedReason")]
    pub disqualified_reason: Option<String>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "productInterest")]
    pub product_interest: Option<Json>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "budget")]
    pub budget: Option<Json>,
    #[sea_orm(column_type = "String(StringLen::N(100))")]
    #[serde(rename = "timeline")]
    pub timeline: Option<String>,
    #[serde(rename = "authority")]
    pub authority: Option<bool>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "need")]
    pub need: Option<String>,
    #[serde(rename = "convertedAt", with = "crate::js::timestamp::option")]
    pub converted_at: Option<TimeDateTime>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "convertedToCustomerId")]
    pub converted_to_customer_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "convertedToCounterpartyId")]
    pub converted_to_counterparty_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "convertedToOpportunityId")]
    pub converted_to_opportunity_id: Option<String>,
    #[serde(rename = "firstResponseAt", with = "crate::js::timestamp::option")]
    pub first_response_at: Option<TimeDateTime>,
    #[serde(rename = "lastActivityAt", with = "crate::js::timestamp::option")]
    pub last_activity_at: Option<TimeDateTime>,
    #[serde(rename = "numberOfTouches")]
    pub number_of_touches: Option<i32>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "notes")]
    pub notes: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(500))")]
    #[serde(rename = "nextAction")]
    pub next_action: Option<String>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "crm_leads",
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
            name: "source",
            sql_type: None,
            default: Some(DdlDefault::Sql("'other'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "status",
            sql_type: None,
            default: Some(DdlDefault::Sql("'new'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "score",
            sql_type: None,
            default: Some(DdlDefault::Number("0")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "is_qualified",
            sql_type: None,
            default: Some(DdlDefault::Bool(false)),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "number_of_touches",
            sql_type: None,
            default: Some(DdlDefault::Number("0")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
    ],
    primary_key: None,
    indexes: &[
        Index {
            name: "crm_leads_email_idx",
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
            name: "crm_leads_status_idx",
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
            name: "crm_leads_source_idx",
            columns: &[IndexColumn {
                expression: "source",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "crm_leads_owner_idx",
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
            name: "crm_leads_is_qualified_idx",
            columns: &[IndexColumn {
                expression: "is_qualified",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
    ],
    foreign_keys: &[],
    uniques: &[],
    checks: &[],
};
