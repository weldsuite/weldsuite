//! `connector_connections`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "connector_connections")]
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
    #[sea_orm(column_type = "String(StringLen::N(100))")]
    #[serde(rename = "provider")]
    pub provider: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "displayName")]
    pub display_name: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "status")]
    pub status: String,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "credentials")]
    pub credentials: Option<Json>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "externalAccountId")]
    pub external_account_id: Option<String>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "enabledSyncs")]
    pub enabled_syncs: Option<Json>,
    #[sea_orm(column_type = "String(StringLen::N(15))")]
    #[serde(rename = "direction")]
    pub direction: String,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "objectSyncDirections")]
    pub object_sync_directions: Option<Json>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "syncWatermarks")]
    pub sync_watermarks: Option<Json>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "settings")]
    pub settings: Option<Json>,
    #[serde(rename = "lastSyncAt", with = "crate::js::timestamp::option")]
    pub last_sync_at: Option<TimeDateTime>,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "lastSyncStatus")]
    pub last_sync_status: Option<String>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "lastError")]
    pub last_error: Option<String>,
    #[serde(rename = "lastErrorAt", with = "crate::js::timestamp::option")]
    pub last_error_at: Option<TimeDateTime>,
    #[serde(rename = "recordsSynced")]
    pub records_synced: i32,
    #[serde(rename = "connectedAt", with = "crate::js::timestamp::option")]
    pub connected_at: Option<TimeDateTime>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "connectedBy")]
    pub connected_by: Option<String>,
    #[serde(rename = "disconnectedAt", with = "crate::js::timestamp::option")]
    pub disconnected_at: Option<TimeDateTime>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "webhookSecret")]
    pub webhook_secret: Option<String>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "webhookRegistrations")]
    pub webhook_registrations: Option<Json>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "connector_connections",
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
            name: "status",
            sql_type: None,
            default: Some(DdlDefault::Sql("'pending'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "direction",
            sql_type: None,
            default: Some(DdlDefault::Sql("'inbound'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "records_synced",
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
            name: "connector_connections_provider_account_live_unique",
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
            filter: Some("\"connector_connections\".\"deleted_at\" is null"),
        },
        Index {
            name: "connector_connections_provider_idx",
            columns: &[IndexColumn {
                expression: "provider",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "connector_connections_status_idx",
            columns: &[IndexColumn {
                expression: "status",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "connector_connections_deleted_at_idx",
            columns: &[IndexColumn {
                expression: "deleted_at",
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
