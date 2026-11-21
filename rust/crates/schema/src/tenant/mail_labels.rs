//! `mail_labels`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "mail_labels")]
pub struct Model {
    #[sea_orm(
        primary_key,
        auto_increment = false,
        column_type = "String(StringLen::N(30))"
    )]
    #[serde(rename = "id")]
    pub id: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "accountId")]
    pub account_id: String,
    #[sea_orm(column_type = "String(StringLen::N(100))")]
    #[serde(rename = "name")]
    pub name: String,
    #[sea_orm(column_type = "String(StringLen::N(7))")]
    #[serde(rename = "color")]
    pub color: Option<String>,
    #[serde(rename = "isSystem")]
    pub is_system: Option<bool>,
    #[sea_orm(column_type = "String(StringLen::N(50))")]
    #[serde(rename = "slug")]
    pub slug: Option<String>,
    #[serde(rename = "messageCount")]
    pub message_count: i32,
    #[serde(rename = "position")]
    pub position: Option<i32>,
    #[serde(rename = "aiEnabled")]
    pub ai_enabled: Option<bool>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "aiKeywords")]
    pub ai_keywords: Option<Json>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "aiDescription")]
    pub ai_description: Option<String>,
    #[serde(rename = "aiConfidence")]
    pub ai_confidence: Option<i32>,
    #[serde(rename = "createdAt", with = "crate::js::timestamp")]
    pub created_at: TimeDateTime,
    #[serde(rename = "updatedAt", with = "crate::js::timestamp")]
    pub updated_at: TimeDateTime,
    #[serde(rename = "deletedAt", with = "crate::js::timestamp::option")]
    pub deleted_at: Option<TimeDateTime>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "mail_labels",
    columns: &[
        DdlColumn {
            name: "is_system",
            sql_type: None,
            default: Some(DdlDefault::Bool(false)),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "message_count",
            sql_type: None,
            default: Some(DdlDefault::Number("0")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "position",
            sql_type: None,
            default: Some(DdlDefault::Number("0")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "ai_enabled",
            sql_type: None,
            default: Some(DdlDefault::Bool(false)),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "ai_confidence",
            sql_type: None,
            default: Some(DdlDefault::Number("70")),
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
            name: "mail_labels_account_id_idx",
            columns: &[IndexColumn {
                expression: "account_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "mail_labels_name_idx",
            columns: &[IndexColumn {
                expression: "name",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
    ],
    foreign_keys: &[ForeignKey {
        name: "mail_labels_account_id_mail_accounts_id_fk",
        columns: &["account_id"],
        references: "mail_accounts",
        referenced_columns: &["id"],
        on_delete: "no action",
        on_update: "no action",
    }],
    uniques: &[],
    checks: &[],
};
