//! `weldpass_secret_versions`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "weldpass_secret_versions")]
pub struct Model {
    #[sea_orm(
        primary_key,
        auto_increment = false,
        column_type = "String(StringLen::N(30))"
    )]
    #[serde(rename = "id")]
    pub id: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "secretId")]
    pub secret_id: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "projectId")]
    pub project_id: String,
    #[serde(rename = "version")]
    pub version: i32,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "action")]
    pub action: String,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "ciphertext")]
    pub ciphertext: String,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "dekWrapped")]
    pub dek_wrapped: String,
    #[sea_orm(column_type = "String(StringLen::N(64))")]
    #[serde(rename = "checksum")]
    pub checksum: String,
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
    name: "weldpass_secret_versions",
    columns: &[DdlColumn {
        name: "created_at",
        sql_type: None,
        default: Some(DdlDefault::Sql("now()")),
        generated: None,
        default_fn: false,
        on_update: false,
    }],
    primary_key: None,
    indexes: &[
        Index {
            name: "weldpass_secret_versions_secret_idx",
            columns: &[IndexColumn {
                expression: "secret_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "weldpass_secret_versions_secret_version_idx",
            columns: &[
                IndexColumn {
                    expression: "secret_id",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "version",
                    is_expression: false,
                    asc: true,
                },
            ],
            unique: true,
            method: "btree",
            filter: None,
        },
    ],
    foreign_keys: &[],
    uniques: &[],
    checks: &[],
};
