//! `commerce_payment_connections`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "commerce_payment_connections")]
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
    #[serde(rename = "provider")]
    pub provider: String,
    #[sea_orm(column_type = "String(StringLen::N(10))")]
    #[serde(rename = "authMethod")]
    pub auth_method: String,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "status")]
    pub status: String,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "accessTokenEncrypted")]
    pub access_token_encrypted: Option<String>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "refreshTokenEncrypted")]
    pub refresh_token_encrypted: Option<String>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "apiKeyEncrypted")]
    pub api_key_encrypted: Option<String>,
    #[serde(rename = "tokenExpiresAt", with = "crate::js::timestamp::option")]
    pub token_expires_at: Option<TimeDateTime>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "scope")]
    pub scope: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(50))")]
    #[serde(rename = "profileId")]
    pub profile_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "profileName")]
    pub profile_name: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(50))")]
    #[serde(rename = "organizationId")]
    pub organization_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "organizationName")]
    pub organization_name: Option<String>,
    #[serde(rename = "testmode")]
    pub testmode: bool,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "connectedBy")]
    pub connected_by: Option<String>,
    #[serde(rename = "connectedAt", with = "crate::js::timestamp::option")]
    pub connected_at: Option<TimeDateTime>,
    #[serde(rename = "disconnectedAt", with = "crate::js::timestamp::option")]
    pub disconnected_at: Option<TimeDateTime>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "lastError")]
    pub last_error: Option<String>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "commerce_payment_connections",
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
            name: "provider",
            sql_type: None,
            default: Some(DdlDefault::Sql("'mollie'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "auth_method",
            sql_type: None,
            default: Some(DdlDefault::Sql("'oauth'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "status",
            sql_type: None,
            default: Some(DdlDefault::Sql("'connected'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "testmode",
            sql_type: None,
            default: Some(DdlDefault::Bool(false)),
            generated: None,
            default_fn: false,
            on_update: false,
        },
    ],
    primary_key: None,
    indexes: &[Index {
        name: "commerce_payment_connections_provider_uidx",
        columns: &[IndexColumn {
            expression: "provider",
            is_expression: false,
            asc: true,
        }],
        unique: true,
        method: "btree",
        filter: Some("\"commerce_payment_connections\".\"deleted_at\" IS NULL"),
    }],
    foreign_keys: &[],
    uniques: &[],
    checks: &[],
};
