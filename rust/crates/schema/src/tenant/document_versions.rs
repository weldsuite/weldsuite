//! `document_versions`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "document_versions")]
pub struct Model {
    #[sea_orm(
        primary_key,
        auto_increment = false,
        column_type = "String(StringLen::N(255))"
    )]
    #[serde(rename = "id")]
    pub id: String,
    #[serde(rename = "createdAt", with = "crate::js::timestamp")]
    pub created_at: TimeDateTime,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "fileId")]
    pub file_id: String,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "content")]
    pub content: Json,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "label")]
    pub label: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "createdById")]
    pub created_by_id: Option<String>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "document_versions",
    columns: &[DdlColumn {
        name: "created_at",
        sql_type: None,
        default: Some(DdlDefault::Sql("now()")),
        generated: None,
        default_fn: false,
        on_update: false,
    }],
    primary_key: None,
    indexes: &[Index {
        name: "document_versions_file_idx",
        columns: &[
            IndexColumn {
                expression: "file_id",
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
    }],
    foreign_keys: &[ForeignKey {
        name: "document_versions_file_id_files_id_fk",
        columns: &["file_id"],
        references: "files",
        referenced_columns: &["id"],
        on_delete: "no action",
        on_update: "no action",
    }],
    uniques: &[],
    checks: &[],
};
