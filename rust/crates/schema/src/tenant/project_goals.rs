//! `project_goals`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "project_goals")]
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
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "mission")]
    pub mission: Option<Json>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "goals")]
    pub goals: Option<Json>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "lastEditedBy")]
    pub last_edited_by: Option<String>,
    #[serde(rename = "createdAt", with = "crate::js::timestamptz::option")]
    pub created_at: Option<TimeDateTimeWithTimeZone>,
    #[serde(rename = "updatedAt", with = "crate::js::timestamptz::option")]
    pub updated_at: Option<TimeDateTimeWithTimeZone>,
    #[serde(rename = "deletedAt", with = "crate::js::timestamptz::option")]
    pub deleted_at: Option<TimeDateTimeWithTimeZone>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "project_goals",
    columns: &[
        DdlColumn {
            name: "goals",
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
    indexes: &[],
    foreign_keys: &[ForeignKey {
        name: "project_goals_project_id_projects_id_fk",
        columns: &["project_id"],
        references: "projects",
        referenced_columns: &["id"],
        on_delete: "no action",
        on_update: "no action",
    }],
    uniques: &[],
    checks: &[],
};
