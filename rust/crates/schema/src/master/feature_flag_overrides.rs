//! `feature_flag_overrides`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "feature_flag_overrides")]
pub struct Model {
    #[sea_orm(
        primary_key,
        auto_increment = false,
        column_type = "String(StringLen::N(30))"
    )]
    #[serde(rename = "id")]
    pub id: String,
    #[sea_orm(column_type = "String(StringLen::N(100))")]
    #[serde(rename = "flagKey")]
    pub flag_key: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "workspaceId")]
    pub workspace_id: Option<String>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "value")]
    pub value: Json,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "updatedBy")]
    pub updated_by: Option<String>,
    #[serde(rename = "updatedAt", with = "crate::js::timestamptz")]
    pub updated_at: TimeDateTimeWithTimeZone,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "feature_flag_overrides",
    columns: &[DdlColumn {
        name: "updated_at",
        sql_type: None,
        default: Some(DdlDefault::Sql("now()")),
        generated: None,
        default_fn: false,
        on_update: false,
    }],
    primary_key: None,
    indexes: &[],
    foreign_keys: &[],
    uniques: &[Unique {
        name: "feature_flag_overrides_flag_workspace_unique",
        columns: &["flag_key", "workspace_id"],
        nulls_not_distinct: true,
    }],
    checks: &[],
};
