//! `desk_sla_clocks`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "desk_sla_clocks")]
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
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "conversationId")]
    pub conversation_id: String,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "metric")]
    pub metric: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "policyId")]
    pub policy_id: Option<String>,
    #[serde(rename = "targetMinutes")]
    pub target_minutes: i32,
    #[serde(rename = "warnBeforeMinutes")]
    pub warn_before_minutes: Option<i32>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "calendar")]
    pub calendar: Option<Json>,
    #[sea_orm(column_type = "String(StringLen::N(10))")]
    #[serde(rename = "status")]
    pub status: String,
    #[serde(rename = "startedAt", with = "crate::js::timestamp")]
    pub started_at: TimeDateTime,
    #[serde(rename = "elapsedSeconds")]
    pub elapsed_seconds: i32,
    #[serde(rename = "dueAt", with = "crate::js::timestamp::option")]
    pub due_at: Option<TimeDateTime>,
    #[serde(rename = "warnAt", with = "crate::js::timestamp::option")]
    pub warn_at: Option<TimeDateTime>,
    #[serde(rename = "breachedAt", with = "crate::js::timestamp::option")]
    pub breached_at: Option<TimeDateTime>,
    #[serde(rename = "completedAt", with = "crate::js::timestamp::option")]
    pub completed_at: Option<TimeDateTime>,
    #[serde(rename = "warnedAt", with = "crate::js::timestamp::option")]
    pub warned_at: Option<TimeDateTime>,
    #[serde(rename = "breachNotifiedAt", with = "crate::js::timestamp::option")]
    pub breach_notified_at: Option<TimeDateTime>,
    #[serde(rename = "nextCheckAt", with = "crate::js::timestamp::option")]
    pub next_check_at: Option<TimeDateTime>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "desk_sla_clocks",
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
            name: "elapsed_seconds",
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
            name: "desk_sla_clocks_conversation_metric_uidx",
            columns: &[
                IndexColumn {
                    expression: "conversation_id",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "metric",
                    is_expression: false,
                    asc: true,
                },
            ],
            unique: true,
            method: "btree",
            filter: None,
        },
        Index {
            name: "desk_sla_clocks_next_check_idx",
            columns: &[IndexColumn {
                expression: "next_check_at",
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
