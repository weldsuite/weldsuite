//! `weldagent_agent_runs`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "weldagent_agent_runs")]
pub struct Model {
    #[sea_orm(
        primary_key,
        auto_increment = false,
        column_type = "String(StringLen::N(30))"
    )]
    #[serde(rename = "id")]
    pub id: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "agentId")]
    pub agent_id: String,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "status")]
    pub status: String,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "triggerType")]
    pub trigger_type: Option<String>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "triggerData")]
    pub trigger_data: Option<Json>,
    #[serde(rename = "startedAt", with = "crate::js::timestamptz::option")]
    pub started_at: Option<TimeDateTimeWithTimeZone>,
    #[serde(rename = "completedAt", with = "crate::js::timestamptz::option")]
    pub completed_at: Option<TimeDateTimeWithTimeZone>,
    #[serde(rename = "durationMs")]
    pub duration_ms: Option<i32>,
    #[serde(rename = "totalIterations")]
    pub total_iterations: Option<i32>,
    #[serde(rename = "totalTokensUsed")]
    pub total_tokens_used: Option<i32>,
    #[serde(rename = "toolCallCount")]
    pub tool_call_count: Option<i32>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "result")]
    pub result: Option<Json>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "error")]
    pub error: Option<String>,
    #[serde(rename = "createdAt", with = "crate::js::timestamptz")]
    pub created_at: TimeDateTimeWithTimeZone,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "weldagent_agent_runs",
    columns: &[
        DdlColumn {
            name: "total_iterations",
            sql_type: None,
            default: Some(DdlDefault::Number("0")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "total_tokens_used",
            sql_type: None,
            default: Some(DdlDefault::Number("0")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "tool_call_count",
            sql_type: None,
            default: Some(DdlDefault::Number("0")),
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
            name: "weldagent_agent_runs_agent_id_idx",
            columns: &[IndexColumn {
                expression: "agent_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "weldagent_agent_runs_status_idx",
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
            name: "weldagent_agent_runs_created_at_idx",
            columns: &[IndexColumn {
                expression: "created_at",
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
