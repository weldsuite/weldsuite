//! `form_versions`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "form_versions")]
pub struct Model {
    #[sea_orm(
        primary_key,
        auto_increment = false,
        column_type = "String(StringLen::N(30))"
    )]
    #[serde(rename = "id")]
    pub id: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "formId")]
    pub form_id: String,
    #[serde(rename = "number")]
    pub number: i32,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "definition")]
    pub definition: Json,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "theme")]
    pub theme: Option<Json>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "publishedByUserId")]
    pub published_by_user_id: String,
    #[serde(rename = "publishedAt", with = "crate::js::timestamptz")]
    pub published_at: TimeDateTimeWithTimeZone,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "form_versions",
    columns: &[DdlColumn {
        name: "published_at",
        sql_type: None,
        default: Some(DdlDefault::Sql("now()")),
        generated: None,
        default_fn: false,
        on_update: false,
    }],
    primary_key: None,
    indexes: &[Index {
        name: "form_versions_form_number_idx",
        columns: &[
            IndexColumn {
                expression: "form_id",
                is_expression: false,
                asc: true,
            },
            IndexColumn {
                expression: "number",
                is_expression: false,
                asc: true,
            },
        ],
        unique: true,
        method: "btree",
        filter: None,
    }],
    foreign_keys: &[],
    uniques: &[],
    checks: &[],
};
