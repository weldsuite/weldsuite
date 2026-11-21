//! `form_abuse_reports`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "form_abuse_reports")]
pub struct Model {
    #[sea_orm(
        primary_key,
        auto_increment = false,
        column_type = "String(StringLen::N(30))"
    )]
    #[serde(rename = "id")]
    pub id: String,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "publicId")]
    pub public_id: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "workspaceId")]
    pub workspace_id: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "formId")]
    pub form_id: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "reason")]
    pub reason: String,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "details")]
    pub details: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(320))")]
    #[serde(rename = "reporterEmail")]
    pub reporter_email: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(64))")]
    #[serde(rename = "reporterIpHash")]
    pub reporter_ip_hash: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "status")]
    pub status: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "resolvedBy")]
    pub resolved_by: Option<String>,
    #[serde(rename = "resolvedAt", with = "crate::js::timestamptz::option")]
    pub resolved_at: Option<TimeDateTimeWithTimeZone>,
    #[serde(rename = "createdAt", with = "crate::js::timestamptz")]
    pub created_at: TimeDateTimeWithTimeZone,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "form_abuse_reports",
    columns: &[
        DdlColumn {
            name: "status",
            sql_type: None,
            default: Some(DdlDefault::Sql("'open'")),
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
    ],
    primary_key: None,
    indexes: &[
        Index {
            name: "form_abuse_reports_status_idx",
            columns: &[
                IndexColumn {
                    expression: "status",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "created_at",
                    is_expression: false,
                    asc: true,
                },
            ],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "form_abuse_reports_public_id_idx",
            columns: &[IndexColumn {
                expression: "public_id",
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
