//! `sync_logs`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "sync_logs")]
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
    #[serde(rename = "platform")]
    pub platform: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "connectionId")]
    pub connection_id: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "syncType")]
    pub sync_type: String,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "status")]
    pub status: String,
    #[sea_orm(column_type = "String(StringLen::N(100))")]
    #[serde(rename = "jobId")]
    pub job_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "triggeredBy")]
    pub triggered_by: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "triggeredByUser")]
    pub triggered_by_user: Option<String>,
    #[serde(rename = "itemsProcessed")]
    pub items_processed: i32,
    #[serde(rename = "totalItems")]
    pub total_items: i32,
    #[serde(rename = "itemsCreated")]
    pub items_created: i32,
    #[serde(rename = "itemsUpdated")]
    pub items_updated: i32,
    #[serde(rename = "itemsFailed")]
    pub items_failed: i32,
    #[serde(rename = "itemsSkipped")]
    pub items_skipped: i32,
    #[serde(rename = "startedAt", with = "crate::js::timestamp::option")]
    pub started_at: Option<TimeDateTime>,
    #[serde(rename = "finishedAt", with = "crate::js::timestamp::option")]
    pub finished_at: Option<TimeDateTime>,
    #[serde(rename = "durationMs")]
    pub duration_ms: Option<i32>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "errorMessage")]
    pub error_message: Option<String>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "errors")]
    pub errors: Option<Json>,
    #[sea_orm(column_type = "String(StringLen::N(15))")]
    #[serde(rename = "direction")]
    pub direction: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(50))")]
    #[serde(rename = "entityType")]
    pub entity_type: Option<String>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "metadata")]
    pub metadata: Option<Json>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "sync_logs",
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
            name: "status",
            sql_type: None,
            default: Some(DdlDefault::Sql("'pending'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "items_processed",
            sql_type: None,
            default: Some(DdlDefault::Number("0")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "total_items",
            sql_type: None,
            default: Some(DdlDefault::Number("0")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "items_created",
            sql_type: None,
            default: Some(DdlDefault::Number("0")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "items_updated",
            sql_type: None,
            default: Some(DdlDefault::Number("0")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "items_failed",
            sql_type: None,
            default: Some(DdlDefault::Number("0")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "items_skipped",
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
            name: "sync_logs_platform_idx",
            columns: &[IndexColumn {
                expression: "platform",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "sync_logs_connection_idx",
            columns: &[IndexColumn {
                expression: "connection_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "sync_logs_status_idx",
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
            name: "sync_logs_created_at_idx",
            columns: &[IndexColumn {
                expression: "created_at",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "sync_logs_job_id_idx",
            columns: &[IndexColumn {
                expression: "job_id",
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
