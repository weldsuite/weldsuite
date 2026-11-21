//! `custom_object_relations`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "custom_object_relations")]
pub struct Model {
    #[sea_orm(
        primary_key,
        auto_increment = false,
        column_type = "String(StringLen::N(30))"
    )]
    #[serde(rename = "id")]
    pub id: String,
    #[serde(rename = "createdAt", with = "crate::js::timestamp")]
    pub created_at: TimeDateTime,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "createdBy")]
    pub created_by: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "linkId")]
    pub link_id: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "sourceEntityKey")]
    pub source_entity_key: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "sourceId")]
    pub source_id: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "targetEntityKey")]
    pub target_entity_key: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "targetId")]
    pub target_id: String,
    #[serde(rename = "sortOrder")]
    pub sort_order: i32,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "custom_object_relations",
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
            name: "sort_order",
            sql_type: None,
            default: Some(DdlDefault::Number("0")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
    ],
    primary_key: None,
    indexes: &[
        Index {
            name: "cor_rel_link_source_target_idx",
            columns: &[
                IndexColumn {
                    expression: "link_id",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "source_id",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "target_id",
                    is_expression: false,
                    asc: true,
                },
            ],
            unique: true,
            method: "btree",
            filter: None,
        },
        Index {
            name: "cor_rel_link_source_idx",
            columns: &[
                IndexColumn {
                    expression: "link_id",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "source_id",
                    is_expression: false,
                    asc: true,
                },
            ],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "cor_rel_link_target_idx",
            columns: &[
                IndexColumn {
                    expression: "link_id",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "target_id",
                    is_expression: false,
                    asc: true,
                },
            ],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "cor_rel_target_idx",
            columns: &[
                IndexColumn {
                    expression: "target_entity_key",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "target_id",
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
