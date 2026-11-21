//! `workflow_schedules`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "workflow_schedules")]
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
    #[serde(rename = "workflowId")]
    pub workflow_id: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "triggerId")]
    pub trigger_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "name")]
    pub name: Option<String>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "description")]
    pub description: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "scheduleType")]
    pub schedule_type: String,
    #[sea_orm(column_type = "String(StringLen::N(100))")]
    #[serde(rename = "cronExpression")]
    pub cron_expression: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(100))")]
    #[serde(rename = "timezone")]
    pub timezone: String,
    #[sea_orm(column_type = "String(StringLen::N(50))")]
    #[serde(rename = "interval")]
    pub interval: Option<String>,
    #[serde(rename = "executeAt", with = "crate::js::timestamp::option")]
    pub execute_at: Option<TimeDateTime>,
    #[serde(rename = "startDate", with = "crate::js::timestamp::option")]
    pub start_date: Option<TimeDateTime>,
    #[serde(rename = "endDate", with = "crate::js::timestamp::option")]
    pub end_date: Option<TimeDateTime>,
    #[serde(rename = "isEnabled")]
    pub is_enabled: bool,
    #[serde(rename = "nextRunAt", with = "crate::js::timestamp::option")]
    pub next_run_at: Option<TimeDateTime>,
    #[serde(rename = "lastRunAt", with = "crate::js::timestamp::option")]
    pub last_run_at: Option<TimeDateTime>,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "lastRunStatus")]
    pub last_run_status: Option<String>,
    #[serde(rename = "totalRuns")]
    pub total_runs: Option<i32>,
    #[serde(rename = "successfulRuns")]
    pub successful_runs: Option<i32>,
    #[serde(rename = "failedRuns")]
    pub failed_runs: Option<i32>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "triggerDevScheduleId")]
    pub trigger_dev_schedule_id: Option<String>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "workflow_schedules",
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
            name: "schedule_type",
            sql_type: None,
            default: Some(DdlDefault::Sql("'recurring'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "timezone",
            sql_type: None,
            default: Some(DdlDefault::Sql("'UTC'")),
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
            name: "total_runs",
            sql_type: None,
            default: Some(DdlDefault::Number("0")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "successful_runs",
            sql_type: None,
            default: Some(DdlDefault::Number("0")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "failed_runs",
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
            name: "workflow_schedules_workflow_idx",
            columns: &[IndexColumn {
                expression: "workflow_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "workflow_schedules_is_enabled_idx",
            columns: &[IndexColumn {
                expression: "is_enabled",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "workflow_schedules_next_run_idx",
            columns: &[IndexColumn {
                expression: "next_run_at",
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
