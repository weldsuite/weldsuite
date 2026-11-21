//! `object_templates`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "object_templates")]
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
    #[serde(rename = "updatedAt", with = "crate::js::timestamp")]
    pub updated_at: TimeDateTime,
    #[serde(rename = "deletedAt", with = "crate::js::timestamp::option")]
    pub deleted_at: Option<TimeDateTime>,
    #[sea_orm(column_type = "String(StringLen::N(50))")]
    #[serde(rename = "entityType")]
    pub entity_type: String,
    #[sea_orm(column_type = "String(StringLen::N(150))")]
    #[serde(rename = "name")]
    pub name: String,
    #[sea_orm(column_type = "String(StringLen::N(150))")]
    #[serde(rename = "slug")]
    pub slug: String,
    #[sea_orm(column_type = "String(StringLen::N(500))")]
    #[serde(rename = "description")]
    pub description: Option<String>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "fields")]
    pub fields: Json,
    #[serde(rename = "isDefault")]
    pub is_default: bool,
    #[serde(rename = "sortOrder")]
    pub sort_order: i32,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "object_templates",
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
            name: "updated_at",
            sql_type: None,
            default: Some(DdlDefault::Sql("now()")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "fields",
            sql_type: None,
            default: Some(DdlDefault::Sql("'[]'::jsonb")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "is_default",
            sql_type: None,
            default: Some(DdlDefault::Bool(false)),
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
            name: "object_templates_entity_type_idx",
            columns: &[IndexColumn {
                expression: "entity_type",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "object_templates_entity_type_slug_idx",
            columns: &[
                IndexColumn {
                    expression: "entity_type",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "slug",
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
