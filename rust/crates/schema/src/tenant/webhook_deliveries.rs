//! `webhook_deliveries`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "webhook_deliveries")]
pub struct Model {
    #[sea_orm(
        primary_key,
        auto_increment = false,
        column_type = "String(StringLen::N(30))"
    )]
    #[serde(rename = "id")]
    pub id: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "webhookId")]
    pub webhook_id: String,
    #[sea_orm(column_type = "String(StringLen::N(100))")]
    #[serde(rename = "eventType")]
    pub event_type: String,
    #[sea_orm(column_type = "String(StringLen::N(50))")]
    #[serde(rename = "eventId")]
    pub event_id: String,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "payload")]
    pub payload: Json,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "status")]
    pub status: String,
    #[serde(rename = "responseStatus")]
    pub response_status: Option<i32>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "responseBody")]
    pub response_body: Option<String>,
    #[serde(rename = "responseTimeMs")]
    pub response_time_ms: Option<i32>,
    #[serde(rename = "attemptNumber")]
    pub attempt_number: i32,
    #[serde(rename = "nextRetryAt", with = "crate::js::timestamptz::option")]
    pub next_retry_at: Option<TimeDateTimeWithTimeZone>,
    #[serde(rename = "maxRetries")]
    pub max_retries: Option<i32>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "errorMessage")]
    pub error_message: Option<String>,
    #[serde(rename = "createdAt", with = "crate::js::timestamptz")]
    pub created_at: TimeDateTimeWithTimeZone,
    #[serde(rename = "deliveredAt", with = "crate::js::timestamptz::option")]
    pub delivered_at: Option<TimeDateTimeWithTimeZone>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "webhook_deliveries",
    columns: &[
        DdlColumn {
            name: "status",
            sql_type: None,
            default: Some(DdlDefault::Sql("'pending'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "attempt_number",
            sql_type: None,
            default: Some(DdlDefault::Number("1")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "max_retries",
            sql_type: None,
            default: Some(DdlDefault::Number("5")),
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
    ],
    primary_key: None,
    indexes: &[
        Index {
            name: "webhook_deliveries_webhook_idx",
            columns: &[IndexColumn {
                expression: "webhook_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "webhook_deliveries_status_idx",
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
            name: "webhook_deliveries_event_idx",
            columns: &[IndexColumn {
                expression: "event_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "webhook_deliveries_retry_idx",
            columns: &[IndexColumn {
                expression: "next_retry_at",
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
