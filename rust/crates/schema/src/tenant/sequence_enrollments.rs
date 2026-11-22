//! `sequence_enrollments`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "sequence_enrollments")]
pub struct Model {
    #[sea_orm(
        primary_key,
        auto_increment = false,
        column_type = "String(StringLen::N(30))"
    )]
    #[serde(rename = "id")]
    pub id: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "sequenceId")]
    pub sequence_id: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "customerId")]
    pub customer_id: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "counterpartyId")]
    pub counterparty_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "status")]
    pub status: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "executionId")]
    pub execution_id: Option<String>,
    #[serde(rename = "currentStepIndex")]
    pub current_step_index: Option<i32>,
    #[serde(rename = "totalSteps")]
    pub total_steps: Option<i32>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "enrolledBy")]
    pub enrolled_by: Option<String>,
    #[serde(rename = "enrolledAt", with = "crate::js::timestamp")]
    pub enrolled_at: TimeDateTime,
    #[serde(rename = "completedAt", with = "crate::js::timestamp::option")]
    pub completed_at: Option<TimeDateTime>,
    #[serde(rename = "pausedAt", with = "crate::js::timestamp::option")]
    pub paused_at: Option<TimeDateTime>,
    #[serde(rename = "unenrolledAt", with = "crate::js::timestamp::option")]
    pub unenrolled_at: Option<TimeDateTime>,
    #[serde(rename = "failedAt", with = "crate::js::timestamp::option")]
    pub failed_at: Option<TimeDateTime>,
    #[sea_orm(column_type = "String(StringLen::N(1000))")]
    #[serde(rename = "errorMessage")]
    pub error_message: Option<String>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "customerSnapshot")]
    pub customer_snapshot: Option<Json>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "sequence_enrollments",
    columns: &[
        DdlColumn {
            name: "status",
            sql_type: None,
            default: Some(DdlDefault::Sql("'active'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "current_step_index",
            sql_type: None,
            default: Some(DdlDefault::Number("0")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "total_steps",
            sql_type: None,
            default: Some(DdlDefault::Number("0")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "enrolled_at",
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
            name: "sequence_enrollments_sequence_id_idx",
            columns: &[IndexColumn {
                expression: "sequence_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "sequence_enrollments_customer_id_idx",
            columns: &[IndexColumn {
                expression: "customer_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "sequence_enrollments_counterparty_idx",
            columns: &[IndexColumn {
                expression: "counterparty_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "sequence_enrollments_status_idx",
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
            name: "sequence_enrollments_execution_id_idx",
            columns: &[IndexColumn {
                expression: "execution_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
    ],
    foreign_keys: &[],
    uniques: &[Unique {
        name: "sequence_enrollments_unique_idx",
        columns: &["sequence_id", "customer_id"],
        nulls_not_distinct: false,
    }],
    checks: &[],
};
