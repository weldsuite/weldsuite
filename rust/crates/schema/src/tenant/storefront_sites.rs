//! `storefront_sites`: a WeldCommerce online store, one per storefront sales channel: its draft site document, the live version, and how it is hosted (built in WeldSuite, or the merchant's own static deployment).

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "storefront_sites")]
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
    #[serde(rename = "channelId")]
    pub channel_id: String,
    #[sea_orm(column_type = "String(StringLen::N(12))")]
    #[serde(rename = "mode")]
    pub mode: String,
    #[sea_orm(column_type = "String(StringLen::N(5))")]
    #[serde(rename = "locale")]
    pub locale: String,
    #[sea_orm(column_type = "String(StringLen::N(40))")]
    #[serde(rename = "theme")]
    pub theme: String,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "draft")]
    pub draft: Json,
    #[serde(rename = "draftRevision")]
    pub draft_revision: i32,
    #[serde(rename = "draftUpdatedAt", with = "crate::js::timestamp::option")]
    pub draft_updated_at: Option<TimeDateTime>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "publishedVersionId")]
    pub published_version_id: Option<String>,
    #[serde(rename = "publishedAt", with = "crate::js::timestamp::option")]
    pub published_at: Option<TimeDateTime>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "activeDeploymentId")]
    pub active_deployment_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(16))")]
    #[serde(rename = "visibility")]
    pub visibility: String,
    #[sea_orm(column_type = "String(StringLen::N(128))")]
    #[serde(rename = "passwordHash")]
    pub password_hash: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "createdBy")]
    pub created_by: Option<String>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "storefront_sites",
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
            name: "draft",
            sql_type: None,
            default: Some(DdlDefault::Sql("'{}'::jsonb")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "draft_revision",
            sql_type: None,
            default: Some(DdlDefault::Number("0")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "locale",
            sql_type: None,
            default: Some(DdlDefault::Sql("'en'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "mode",
            sql_type: None,
            default: Some(DdlDefault::Sql("'builder'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "theme",
            sql_type: None,
            default: Some(DdlDefault::Sql("'atelier'")),
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
            name: "visibility",
            sql_type: None,
            default: Some(DdlDefault::Sql("'live'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
    ],
    primary_key: None,
    indexes: &[Index {
        name: "storefront_sites_channel_uidx",
        columns: &[IndexColumn {
            expression: "channel_id",
            is_expression: false,
            asc: true,
        }],
        unique: true,
        method: "btree",
        filter: Some("\"storefront_sites\".\"deleted_at\" IS NULL"),
    }],
    foreign_keys: &[],
    uniques: &[],
    checks: &[],
};
