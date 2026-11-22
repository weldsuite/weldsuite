//! `enterprise_inquiries`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "enterprise_inquiries")]
pub struct Model {
    #[sea_orm(
        primary_key,
        auto_increment = false,
        column_type = "String(StringLen::N(30))"
    )]
    #[serde(rename = "id")]
    pub id: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "companyName")]
    pub company_name: String,
    #[sea_orm(column_type = "String(StringLen::N(50))")]
    #[serde(rename = "teamSize")]
    pub team_size: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "contactName")]
    pub contact_name: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "contactEmail")]
    pub contact_email: String,
    #[sea_orm(column_type = "String(StringLen::N(50))")]
    #[serde(rename = "contactPhone")]
    pub contact_phone: Option<String>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "useCase")]
    pub use_case: Option<String>,
    #[serde(rename = "status")]
    pub status: super::enums::InquiryStatus,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "notes")]
    pub notes: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "assignedTo")]
    pub assigned_to: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(100))")]
    #[serde(rename = "source")]
    pub source: Option<String>,
    #[serde(rename = "createdAt", with = "crate::js::timestamptz")]
    pub created_at: TimeDateTimeWithTimeZone,
    #[serde(rename = "updatedAt", with = "crate::js::timestamptz")]
    pub updated_at: TimeDateTimeWithTimeZone,
    #[serde(rename = "contactedAt", with = "crate::js::timestamptz::option")]
    pub contacted_at: Option<TimeDateTimeWithTimeZone>,
    #[serde(rename = "closedAt", with = "crate::js::timestamptz::option")]
    pub closed_at: Option<TimeDateTimeWithTimeZone>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "enterprise_inquiries",
    columns: &[
        DdlColumn {
            name: "status",
            sql_type: None,
            default: Some(DdlDefault::Sql("'new'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "source",
            sql_type: None,
            default: Some(DdlDefault::Sql("'pricing_dialog'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
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
    ],
    primary_key: None,
    indexes: &[
        Index {
            name: "enterprise_inquiries_status_idx",
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
            name: "enterprise_inquiries_email_idx",
            columns: &[IndexColumn {
                expression: "contact_email",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "enterprise_inquiries_created_idx",
            columns: &[IndexColumn {
                expression: "created_at",
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
