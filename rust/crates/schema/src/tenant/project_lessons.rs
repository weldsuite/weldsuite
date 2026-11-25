//! `project_lessons`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "project_lessons")]
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
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "category")]
    pub category: String,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "text")]
    pub text: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "authorId")]
    pub author_id: String,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "votes")]
    pub votes: Json,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "knowPageId")]
    pub know_page_id: Option<String>,
    /// The sprint whose retro this card belongs to; null for a lesson of the
    /// whole project. Left out of answers while null.
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "sprintId", skip_serializing_if = "Option::is_none")]
    pub sprint_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "createdBy")]
    pub created_by: String,
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
    name: "project_lessons",
    columns: &[
        DdlColumn {
            name: "votes",
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
    indexes: &[
        Index {
            name: "project_lessons_project_category_idx",
            columns: &[
                IndexColumn {
                    expression: "project_id",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "category",
                    is_expression: false,
                    asc: true,
                },
            ],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "project_lessons_sprint_idx",
            columns: &[IndexColumn {
                expression: "sprint_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
    ],
    foreign_keys: &[ForeignKey {
        name: "project_lessons_project_id_projects_id_fk",
        columns: &["project_id"],
        references: "projects",
        referenced_columns: &["id"],
        on_delete: "no action",
        on_update: "no action",
    }],
    uniques: &[],
    checks: &[Check {
        name: "project_lessons_category_check",
        // `action`: a sprint retro's actions (ADR FLOW-024); only sprint cards use it.
        expression: "\"project_lessons\".\"category\" in ('went_well', 'went_badly', 'do_differently', 'action')",
    }],
};
