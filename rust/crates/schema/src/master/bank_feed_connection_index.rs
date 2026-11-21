//! `bank_feed_connection_index`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "bank_feed_connection_index")]
pub struct Model {
    #[sea_orm(
        primary_key,
        auto_increment = false,
        column_type = "String(StringLen::N(30))"
    )]
    #[serde(rename = "id")]
    pub id: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "provider")]
    pub provider: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "providerConnectionId")]
    pub provider_connection_id: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "clerkOrgId")]
    pub clerk_org_id: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "connectionId")]
    pub connection_id: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "entityId")]
    pub entity_id: String,
    #[serde(rename = "isActive")]
    pub is_active: bool,
    #[serde(rename = "syncIntervalHours")]
    pub sync_interval_hours: i32,
    #[serde(rename = "nextSyncAt", with = "crate::js::timestamptz::option")]
    pub next_sync_at: Option<TimeDateTimeWithTimeZone>,
    #[serde(rename = "lastTriggeredAt", with = "crate::js::timestamptz::option")]
    pub last_triggered_at: Option<TimeDateTimeWithTimeZone>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "lastError")]
    pub last_error: Option<String>,
    #[serde(rename = "createdAt", with = "crate::js::timestamptz")]
    pub created_at: TimeDateTimeWithTimeZone,
    #[serde(rename = "updatedAt", with = "crate::js::timestamptz")]
    pub updated_at: TimeDateTimeWithTimeZone,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "bank_feed_connection_index",
    columns: &[
        DdlColumn {
            name: "is_active",
            sql_type: None,
            default: Some(DdlDefault::Bool(true)),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "sync_interval_hours",
            sql_type: None,
            default: Some(DdlDefault::Number("24")),
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
    indexes: &[
        Index {
            name: "bank_feed_connection_index_provider_uidx",
            columns: &[
                IndexColumn {
                    expression: "provider",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "provider_connection_id",
                    is_expression: false,
                    asc: true,
                },
            ],
            unique: true,
            method: "btree",
            filter: None,
        },
        Index {
            name: "bank_feed_connection_index_org_idx",
            columns: &[IndexColumn {
                expression: "clerk_org_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "bank_feed_connection_index_next_sync_idx",
            columns: &[IndexColumn {
                expression: "next_sync_at",
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
