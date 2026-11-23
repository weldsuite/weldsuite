//! `storefront_site_versions`: the published versions of an online store: immutable snapshots of the site document with its pages, menus and redirects.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "storefront_site_versions")]
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
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "siteId")]
    pub site_id: String,
    #[serde(rename = "number")]
    pub number: i32,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "document")]
    pub document: Json,
    #[sea_orm(column_type = "String(StringLen::N(500))")]
    #[serde(rename = "note")]
    pub note: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "publishedBy")]
    pub published_by: Option<String>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "storefront_site_versions",
    columns: &[DdlColumn {
        name: "created_at",
        sql_type: None,
        default: Some(DdlDefault::Sql("now()")),
        generated: None,
        default_fn: false,
        on_update: false,
    }],
    primary_key: None,
    indexes: &[Index {
        name: "storefront_site_versions_site_number_uidx",
        columns: &[
            IndexColumn {
                expression: "site_id",
                is_expression: false,
                asc: true,
            },
            IndexColumn {
                expression: "number",
                is_expression: false,
                asc: true,
            },
        ],
        unique: true,
        method: "btree",
        filter: None,
    }],
    foreign_keys: &[],
    uniques: &[],
    checks: &[],
};
