//! `weldagent_routine_runs`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "weldagent_routine_runs")]
pub struct Model {
    #[sea_orm(
        primary_key,
        auto_increment = false,
        column_type = "String(StringLen::N(30))"
    )]
    #[serde(rename = "id")]
    pub id: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "routineId")]
    pub routine_id: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "agentId")]
    pub agent_id: String,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "status")]
    pub status: String,
    #[sea_orm(column_type = "String(StringLen::N(40))")]
    #[serde(rename = "trigger")]
    pub trigger: String,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "summary")]
    pub summary: Option<String>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "error")]
    pub error: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "agentRunId")]
    pub agent_run_id: Option<String>,
    #[serde(rename = "startedAt", with = "crate::js::timestamptz::option")]
    pub started_at: Option<TimeDateTimeWithTimeZone>,
    #[serde(rename = "completedAt", with = "crate::js::timestamptz::option")]
    pub completed_at: Option<TimeDateTimeWithTimeZone>,
    #[serde(rename = "createdAt", with = "crate::js::timestamptz")]
    pub created_at: TimeDateTimeWithTimeZone,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "weldagent_routine_runs",
    columns: &[
        DdlColumn {
            name: "status",
            sql_type: None,
            default: Some(DdlDefault::Sql("'queued'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "trigger",
            sql_type: None,
            default: Some(DdlDefault::Sql("'schedule'")),
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
            name: "weldagent_routine_runs_routine_idx",
            columns: &[IndexColumn {
                expression: "routine_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "weldagent_routine_runs_created_idx",
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
