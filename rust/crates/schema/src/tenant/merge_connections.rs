//! `merge_connections`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "merge_connections")]
pub struct Model {
    #[sea_orm(
        primary_key,
        auto_increment = false,
        column_type = "String(StringLen::N(30))"
    )]
    #[serde(rename = "id")]
    pub id: String,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "provider")]
    pub provider: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "externalAccountId")]
    pub external_account_id: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "accountLogin")]
    pub account_login: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "accountType")]
    pub account_type: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(500))")]
    #[serde(rename = "host")]
    pub host: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "status")]
    pub status: String,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "credentials")]
    pub credentials: Option<String>,
    #[serde(
        rename = "credentialsExpireAt",
        with = "crate::js::timestamptz::option"
    )]
    pub credentials_expire_at: Option<TimeDateTimeWithTimeZone>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "webhookSecret")]
    pub webhook_secret: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "appSlug")]
    pub app_slug: Option<String>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "scopes")]
    pub scopes: Option<Json>,
    #[serde(rename = "installedAt", with = "crate::js::timestamptz::option")]
    pub installed_at: Option<TimeDateTimeWithTimeZone>,
    #[serde(rename = "revokedAt", with = "crate::js::timestamptz::option")]
    pub revoked_at: Option<TimeDateTimeWithTimeZone>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "oauthUserLogin")]
    pub oauth_user_login: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "createdByUserId")]
    pub created_by_user_id: String,
    #[serde(rename = "createdAt", with = "crate::js::timestamptz")]
    pub created_at: TimeDateTimeWithTimeZone,
    #[serde(rename = "updatedAt", with = "crate::js::timestamptz")]
    pub updated_at: TimeDateTimeWithTimeZone,
    #[serde(rename = "deletedAt", with = "crate::js::timestamptz::option")]
    pub deleted_at: Option<TimeDateTimeWithTimeZone>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "merge_connections",
    columns: &[
        DdlColumn {
            name: "status",
            sql_type: None,
            default: Some(DdlDefault::Sql("'active'")),
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
        name: "merge_connections_account_idx",
        columns: &[
            IndexColumn {
                expression: "provider",
                is_expression: false,
                asc: true,
            },
            IndexColumn {
                expression: "external_account_id",
                is_expression: false,
                asc: true,
            },
        ],
        unique: true,
        method: "btree",
        filter: Some("\"merge_connections\".\"deleted_at\" IS NULL"),
    }],
    foreign_keys: &[],
    uniques: &[],
    checks: &[],
};
