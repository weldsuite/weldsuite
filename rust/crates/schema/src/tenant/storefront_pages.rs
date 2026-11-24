//! `storefront_pages`: the content pages of an online store (about, contact, legal pages); published with the site.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "storefront_pages")]
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
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "siteId")]
    pub site_id: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "title")]
    pub title: String,
    #[sea_orm(column_type = "String(StringLen::N(120))")]
    #[serde(rename = "slug")]
    pub slug: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "seoTitle")]
    pub seo_title: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(500))")]
    #[serde(rename = "seoDescription")]
    pub seo_description: Option<String>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "sections")]
    pub sections: Json,
    #[serde(rename = "visible")]
    pub visible: bool,
    #[serde(rename = "position")]
    pub position: i32,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "createdBy")]
    pub created_by: Option<String>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "storefront_pages",
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
            name: "position",
            sql_type: None,
            default: Some(DdlDefault::Number("0")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "sections",
            sql_type: None,
            default: Some(DdlDefault::Sql("'[]'::jsonb")),
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
            name: "visible",
            sql_type: None,
            default: Some(DdlDefault::Bool(true)),
            generated: None,
            default_fn: false,
            on_update: false,
        },
    ],
    primary_key: None,
    indexes: &[Index {
        name: "storefront_pages_site_slug_uidx",
        columns: &[
            IndexColumn {
                expression: "site_id",
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
        filter: Some("\"storefront_pages\".\"deleted_at\" IS NULL"),
    }],
    foreign_keys: &[],
    uniques: &[],
    checks: &[],
};
