//! `panel_identity_links`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "panel_identity_links")]
pub struct Model {
    #[sea_orm(
        primary_key,
        auto_increment = false,
        column_type = "String(StringLen::N(30))"
    )]
    #[serde(rename = "id")]
    pub id: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "workspaceId")]
    pub workspace_id: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "projectId")]
    pub project_id: String,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "anonId")]
    pub anon_id: String,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "userId")]
    pub user_id: String,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "ts")]
    pub ts: String,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "panel_identity_links",
    columns: &[],
    primary_key: None,
    indexes: &[
        Index {
            name: "panel_identity_links_anon_idx",
            columns: &[
                IndexColumn {
                    expression: "workspace_id",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "project_id",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "anon_id",
                    is_expression: false,
                    asc: true,
                },
            ],
            unique: true,
            method: "btree",
            filter: None,
        },
        Index {
            name: "panel_identity_links_user_idx",
            columns: &[
                IndexColumn {
                    expression: "workspace_id",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "project_id",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "user_id",
                    is_expression: false,
                    asc: true,
                },
            ],
            unique: false,
            method: "btree",
            filter: None,
        },
    ],
    foreign_keys: &[],
    uniques: &[],
    checks: &[],
};
