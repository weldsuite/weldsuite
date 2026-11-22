//! `mail_suppressions`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "mail_suppressions")]
pub struct Model {
    #[sea_orm(
        primary_key,
        auto_increment = false,
        column_type = "String(StringLen::N(30))"
    )]
    #[serde(rename = "id")]
    pub id: String,
    #[sea_orm(column_type = "String(StringLen::N(320))")]
    #[serde(rename = "email")]
    pub email: String,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "reason")]
    pub reason: String,
    #[sea_orm(column_type = "String(StringLen::N(320))")]
    #[serde(rename = "senderEmail")]
    pub sender_email: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(40))")]
    #[serde(rename = "source")]
    pub source: String,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "details")]
    pub details: Option<Json>,
    #[serde(rename = "createdAt", with = "crate::js::timestamp")]
    pub created_at: TimeDateTime,
    #[serde(rename = "updatedAt", with = "crate::js::timestamp")]
    pub updated_at: TimeDateTime,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "mail_suppressions",
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
    ],
    primary_key: None,
    indexes: &[Index {
        name: "mail_suppressions_reason_idx",
        columns: &[IndexColumn {
            expression: "reason",
            is_expression: false,
            asc: true,
        }],
        unique: false,
        method: "btree",
        filter: None,
    }],
    foreign_keys: &[],
    uniques: &[Unique {
        name: "mail_suppressions_email_unique",
        columns: &["email"],
        nulls_not_distinct: false,
    }],
    checks: &[],
};
