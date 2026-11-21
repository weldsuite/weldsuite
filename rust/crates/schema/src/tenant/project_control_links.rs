//! `project_control_links`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "project_control_links")]
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
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "fromType")]
    pub from_type: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "fromId")]
    pub from_id: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "toType")]
    pub to_type: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "toId")]
    pub to_id: String,
    #[sea_orm(column_name = "relation", column_type = "String(StringLen::N(30))")]
    #[serde(rename = "relation")]
    pub relation_: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "createdBy")]
    pub created_by: String,
    #[serde(rename = "createdAt", with = "crate::js::timestamptz")]
    pub created_at: TimeDateTimeWithTimeZone,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "project_control_links",
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
            name: "project_control_links_pair_idx",
            columns: &[
                IndexColumn {
                    expression: "from_type",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "from_id",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "to_type",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "to_id",
                    is_expression: false,
                    asc: true,
                },
            ],
            unique: true,
            method: "btree",
            filter: None,
        },
        Index {
            name: "project_control_links_to_idx",
            columns: &[
                IndexColumn {
                    expression: "to_type",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "to_id",
                    is_expression: false,
                    asc: true,
                },
            ],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "project_control_links_project_idx",
            columns: &[IndexColumn {
                expression: "project_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
    ],
    foreign_keys: &[ForeignKey {
        name: "project_control_links_project_id_projects_id_fk",
        columns: &["project_id"],
        references: "projects",
        referenced_columns: &["id"],
        on_delete: "no action",
        on_update: "no action",
    }],
    uniques: &[],
    checks: &[],
};
