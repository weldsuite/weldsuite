//! `helpcenter_settings`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "helpcenter_settings")]
pub struct Model {
    #[sea_orm(
        primary_key,
        auto_increment = false,
        column_type = "String(StringLen::N(30))"
    )]
    #[serde(rename = "id")]
    pub id: String,
    #[serde(rename = "isEnabled")]
    pub is_enabled: Option<i32>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "siteName")]
    pub site_name: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(500))")]
    #[serde(rename = "logo")]
    pub logo: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(500))")]
    #[serde(rename = "logoDark")]
    pub logo_dark: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(500))")]
    #[serde(rename = "favicon")]
    pub favicon: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "primaryColor")]
    pub primary_color: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "accentColor")]
    pub accent_color: Option<String>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "heroTitle")]
    pub hero_title: Option<String>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "heroSubtitle")]
    pub hero_subtitle: Option<String>,
    #[serde(rename = "showSearch")]
    pub show_search: Option<i32>,
    #[serde(rename = "showCategories")]
    pub show_categories: Option<i32>,
    #[serde(rename = "portalEnabled")]
    pub portal_enabled: Option<i32>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "metaTitle")]
    pub meta_title: Option<String>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "metaDescription")]
    pub meta_description: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(500))")]
    #[serde(rename = "ogImage")]
    pub og_image: Option<String>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "footerText")]
    pub footer_text: Option<String>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "socialLinks")]
    pub social_links: Option<Json>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "customCss")]
    pub custom_css: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(50))")]
    #[serde(rename = "googleAnalyticsId")]
    pub google_analytics_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "defaultSubdomain")]
    pub default_subdomain: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "customDomain")]
    pub custom_domain: Option<String>,
    #[serde(rename = "createdAt", with = "crate::js::timestamp")]
    pub created_at: TimeDateTime,
    #[serde(rename = "updatedAt", with = "crate::js::timestamp")]
    pub updated_at: TimeDateTime,
    #[serde(rename = "deletedAt", with = "crate::js::timestamp::option")]
    pub deleted_at: Option<TimeDateTime>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "helpcenter_settings",
    columns: &[
        DdlColumn {
            name: "is_enabled",
            sql_type: None,
            default: Some(DdlDefault::Number("0")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "show_search",
            sql_type: None,
            default: Some(DdlDefault::Number("1")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "show_categories",
            sql_type: None,
            default: Some(DdlDefault::Number("1")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "portal_enabled",
            sql_type: None,
            default: Some(DdlDefault::Number("0")),
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
    indexes: &[Index {
        name: "helpcenter_settings_is_enabled_idx",
        columns: &[IndexColumn {
            expression: "is_enabled",
            is_expression: false,
            asc: true,
        }],
        unique: false,
        method: "btree",
        filter: None,
    }],
    foreign_keys: &[],
    uniques: &[],
    checks: &[],
};
