//! `board_versions`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "board_versions")]
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
    #[serde(rename = "boardId")]
    pub board_id: String,
    #[serde(rename = "revision")]
    pub revision: i32,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "name")]
    pub name: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(1000))")]
    #[serde(rename = "snapshotKey")]
    pub snapshot_key: String,
    #[serde(rename = "size")]
    pub size: i32,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "createdById")]
    pub created_by_id: Option<String>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "board_versions",
    columns: &[
        DdlColumn {
            name: "created_at",
            sql_type: None,
            default: Some(DdlDefault::Sql("now()")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "size",
            sql_type: None,
            default: Some(DdlDefault::Number("0")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
    ],
    primary_key: None,
    indexes: &[Index {
        name: "board_versions_board_idx",
        columns: &[
            IndexColumn {
                expression: "board_id",
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
        name: "board_versions_board_id_whiteboards_id_fk",
        columns: &["board_id"],
        references: "whiteboards",
        referenced_columns: &["id"],
        on_delete: "cascade",
        on_update: "no action",
    }],
    uniques: &[],
    checks: &[],
};
