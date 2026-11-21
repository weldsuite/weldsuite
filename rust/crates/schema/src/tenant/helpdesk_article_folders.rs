//! `helpdesk_article_folders`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "helpdesk_article_folders")]
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
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "name")]
    pub name: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "slug")]
    pub slug: Option<String>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "description")]
    pub description: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "parentId")]
    pub parent_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(1000))")]
    #[serde(rename = "path")]
    pub path: Option<String>,
    #[serde(rename = "level")]
    pub level: i32,
    #[serde(rename = "sortOrder")]
    pub sort_order: i32,
    #[sea_orm(column_type = "String(StringLen::N(100))")]
    #[serde(rename = "icon")]
    pub icon: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "color")]
    pub color: Option<String>,
    #[serde(rename = "articleCount")]
    pub article_count: i32,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "helpdesk_article_folders",
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
            name: "level",
            sql_type: None,
            default: Some(DdlDefault::Number("0")),
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
        DdlColumn {
            name: "article_count",
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
            name: "helpdesk_article_folders_parent_idx",
            columns: &[IndexColumn {
                expression: "parent_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "helpdesk_article_folders_slug_idx",
            columns: &[IndexColumn {
                expression: "slug",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "helpdesk_article_folders_sort_order_idx",
            columns: &[IndexColumn {
                expression: "sort_order",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
    ],
    foreign_keys: &[],
    uniques: &[],
    checks: &[],
};
