//! `reach_campaigns`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "reach_campaigns")]
pub struct Model {
    #[sea_orm(
        primary_key,
        auto_increment = false,
        column_type = "String(StringLen::N(30))"
    )]
    #[serde(rename = "id")]
    pub id: String,
    #[sea_orm(column_type = "String(StringLen::N(200))")]
    #[serde(rename = "name")]
    pub name: String,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "status")]
    pub status: String,
    #[sea_orm(column_type = "String(StringLen::N(64))")]
    #[serde(rename = "timezone")]
    pub timezone: String,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "sendDays")]
    pub send_days: Json,
    #[sea_orm(column_type = "String(StringLen::N(5))")]
    #[serde(rename = "windowStart")]
    pub window_start: String,
    #[sea_orm(column_type = "String(StringLen::N(5))")]
    #[serde(rename = "windowEnd")]
    pub window_end: String,
    #[serde(rename = "dailyLimit")]
    pub daily_limit: i32,
    #[serde(rename = "minGapMinutes")]
    pub min_gap_minutes: i32,
    #[serde(rename = "stopOnAutoReply")]
    pub stop_on_auto_reply: bool,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "stats")]
    pub stats: Json,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "pausedReason")]
    pub paused_reason: Option<String>,
    #[serde(rename = "launchedAt", with = "crate::js::timestamptz::option")]
    pub launched_at: Option<TimeDateTimeWithTimeZone>,
    #[serde(rename = "completedAt", with = "crate::js::timestamptz::option")]
    pub completed_at: Option<TimeDateTimeWithTimeZone>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "ownerId")]
    pub owner_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "createdBy")]
    pub created_by: Option<String>,
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
    name: "reach_campaigns",
    columns: &[
        DdlColumn {
            name: "status",
            sql_type: None,
            default: Some(DdlDefault::Sql("'draft'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "timezone",
            sql_type: None,
            default: Some(DdlDefault::Sql("'Europe/Amsterdam'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "send_days",
            sql_type: None,
            default: Some(DdlDefault::Sql("'[1,2,3,4,5]'::jsonb")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "window_start",
            sql_type: None,
            default: Some(DdlDefault::Sql("'09:00'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "window_end",
            sql_type: None,
            default: Some(DdlDefault::Sql("'17:00'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "daily_limit",
            sql_type: None,
            default: Some(DdlDefault::Number("100")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "min_gap_minutes",
            sql_type: None,
            default: Some(DdlDefault::Number("8")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "stop_on_auto_reply",
            sql_type: None,
            default: Some(DdlDefault::Bool(false)),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "stats",
            sql_type: None,
            default: Some(DdlDefault::Sql(
                "'{\"prospects\":0,\"sent\":0,\"replied\":0,\"interested\":0,\"bounced\":0,\"unsubscribed\":0}'::jsonb",
            )),
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
        name: "reach_campaigns_status_idx",
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
