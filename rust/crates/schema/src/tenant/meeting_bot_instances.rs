//! `meeting_bot_instances`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "meeting_bot_instances")]
pub struct Model {
    #[sea_orm(
        primary_key,
        auto_increment = false,
        column_type = "String(StringLen::N(100))"
    )]
    #[serde(rename = "id")]
    pub id: String,
    #[serde(rename = "createdAt", with = "crate::js::timestamp")]
    pub created_at: TimeDateTime,
    #[serde(rename = "updatedAt", with = "crate::js::timestamp")]
    pub updated_at: TimeDateTime,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "name")]
    pub name: String,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "serviceUrl")]
    pub service_url: String,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "status")]
    pub status: String,
    #[serde(rename = "lastHealthCheck", with = "crate::js::timestamp::option")]
    pub last_health_check: Option<TimeDateTime>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "lastError")]
    pub last_error: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "currentSessionId")]
    pub current_session_id: Option<String>,
    #[serde(rename = "totalMeetingsProcessed")]
    pub total_meetings_processed: Option<i32>,
    #[serde(rename = "totalRecordingMinutes")]
    pub total_recording_minutes: Option<i32>,
    #[serde(rename = "isEnabled")]
    pub is_enabled: Option<bool>,
    #[serde(rename = "priority")]
    pub priority: Option<i32>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "meeting_bot_instances",
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
            default: Some(DdlDefault::Sql("'available'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "total_meetings_processed",
            sql_type: None,
            default: Some(DdlDefault::Number("0")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "total_recording_minutes",
            sql_type: None,
            default: Some(DdlDefault::Number("0")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "is_enabled",
            sql_type: None,
            default: Some(DdlDefault::Bool(true)),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "priority",
            sql_type: None,
            default: Some(DdlDefault::Number("0")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
    ],
    primary_key: None,
    indexes: &[Index {
        name: "meeting_bot_instances_status_idx",
        columns: &[IndexColumn {
            expression: "status",
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
