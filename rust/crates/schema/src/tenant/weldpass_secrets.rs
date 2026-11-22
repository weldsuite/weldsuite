//! `weldpass_secrets`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "weldpass_secrets")]
pub struct Model {
    #[sea_orm(
        primary_key,
        auto_increment = false,
        column_type = "String(StringLen::N(30))"
    )]
    #[serde(rename = "id")]
    pub id: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "projectId")]
    pub project_id: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "environmentId")]
    pub environment_id: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "key")]
    pub key: String,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "ciphertext")]
    pub ciphertext: String,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "dekWrapped")]
    pub dek_wrapped: String,
    #[sea_orm(column_type = "String(StringLen::N(64))")]
    #[serde(rename = "checksum")]
    pub checksum: String,
    #[serde(rename = "valueLength")]
    pub value_length: i32,
    #[sea_orm(column_type = "String(StringLen::N(8))")]
    #[serde(rename = "valueHint")]
    pub value_hint: Option<String>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "note")]
    pub note: Option<String>,
    #[serde(rename = "version")]
    pub version: i32,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "createdBy")]
    pub created_by: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "updatedBy")]
    pub updated_by: Option<String>,
    #[serde(rename = "createdAt", with = "crate::js::timestamptz")]
    pub created_at: TimeDateTimeWithTimeZone,
    #[serde(rename = "updatedAt", with = "crate::js::timestamptz")]
    pub updated_at: TimeDateTimeWithTimeZone,
    #[serde(rename = "deletedAt", with = "crate::js::timestamptz::option")]
    pub deleted_at: Option<TimeDateTimeWithTimeZone>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "weldpass_secrets",
    columns: &[
        DdlColumn {
            name: "value_length",
            sql_type: None,
            default: Some(DdlDefault::Number("0")),
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
            name: "weldpass_secrets_project_idx",
            columns: &[IndexColumn {
                expression: "project_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "weldpass_secrets_environment_idx",
            columns: &[IndexColumn {
                expression: "environment_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "weldpass_secrets_environment_key_idx",
            columns: &[
                IndexColumn {
                    expression: "environment_id",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "key",
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
