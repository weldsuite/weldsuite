//! `reach_suppressions`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "reach_suppressions")]
pub struct Model {
    #[sea_orm(
        primary_key,
        auto_increment = false,
        column_type = "String(StringLen::N(30))"
    )]
    #[serde(rename = "id")]
    pub id: String,
    #[sea_orm(column_type = "String(StringLen::N(320))")]
    #[serde(rename = "value")]
    pub value: String,
    #[sea_orm(column_name = "type", column_type = "String(StringLen::N(10))")]
    #[serde(rename = "type")]
    pub type_: String,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "reason")]
    pub reason: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "source")]
    pub source: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "createdBy")]
    pub created_by: Option<String>,
    #[serde(rename = "createdAt", with = "crate::js::timestamptz")]
    pub created_at: TimeDateTimeWithTimeZone,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "reach_suppressions",
    columns: &[
        DdlColumn {
            name: "type",
            sql_type: None,
            default: Some(DdlDefault::Sql("'email'")),
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
    indexes: &[Index {
        name: "reach_suppressions_value_idx",
        columns: &[IndexColumn {
            expression: "value",
            is_expression: false,
            asc: true,
        }],
        unique: true,
        method: "btree",
        filter: None,
    }],
    foreign_keys: &[],
    uniques: &[],
    checks: &[],
};
