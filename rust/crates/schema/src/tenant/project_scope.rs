//! `project_scope`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "project_scope")]
pub struct Model {
    #[sea_orm(
        primary_key,
        auto_increment = false,
        column_type = "String(StringLen::N(30))"
    )]
    #[serde(rename = "id")]
    pub id: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "projectId")]
    pub project_id: String,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "statement")]
    pub statement: Option<String>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "inScope")]
    pub in_scope: Json,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "outOfScope")]
    pub out_of_scope: Json,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "createdBy")]
    pub created_by: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "updatedBy")]
    pub updated_by: Option<String>,
    #[serde(rename = "createdAt", with = "crate::js::timestamptz")]
    pub created_at: TimeDateTimeWithTimeZone,
    #[serde(rename = "updatedAt", with = "crate::js::timestamptz")]
    pub updated_at: TimeDateTimeWithTimeZone,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "project_scope",
    columns: &[
        DdlColumn {
            name: "in_scope",
            sql_type: None,
            default: Some(DdlDefault::Sql("'[]'::jsonb")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "out_of_scope",
            sql_type: None,
            default: Some(DdlDefault::Sql("'[]'::jsonb")),
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
    indexes: &[Index {
        name: "project_scope_project_idx",
        columns: &[IndexColumn {
            expression: "project_id",
            is_expression: false,
            asc: true,
        }],
        unique: true,
        method: "btree",
        filter: None,
    }],
    foreign_keys: &[ForeignKey {
        name: "project_scope_project_id_projects_id_fk",
        columns: &["project_id"],
        references: "projects",
        referenced_columns: &["id"],
        on_delete: "no action",
        on_update: "no action",
    }],
    uniques: &[],
    checks: &[],
};
