//! `hr_pay_runs`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "hr_pay_runs")]
pub struct Model {
    #[sea_orm(
        primary_key,
        auto_increment = false,
        column_type = "String(StringLen::N(30))"
    )]
    #[serde(rename = "id")]
    pub id: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "employerId")]
    pub employer_id: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "payScheduleId")]
    pub pay_schedule_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(2))")]
    #[serde(rename = "country")]
    pub country: String,
    #[sea_orm(column_type = "String(StringLen::N(3))")]
    #[serde(rename = "currency")]
    pub currency: String,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "kind")]
    pub kind: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "correctsRunId")]
    pub corrects_run_id: Option<String>,
    #[serde(rename = "periodStart", with = "crate::js::date")]
    pub period_start: TimeDate,
    #[serde(rename = "periodEnd", with = "crate::js::date")]
    pub period_end: TimeDate,
    #[serde(rename = "payDate", with = "crate::js::date")]
    pub pay_date: TimeDate,
    #[serde(rename = "taxYear")]
    pub tax_year: i32,
    #[serde(rename = "periodNumber")]
    pub period_number: i32,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "status")]
    pub status: String,
    #[serde(rename = "employeeCount")]
    pub employee_count: i32,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "excludedEmployeeIds")]
    pub excluded_employee_ids: Json,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "includedEmployeeIds")]
    pub included_employee_ids: Option<Json>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "totals")]
    pub totals: Option<Json>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "issues")]
    pub issues: Json,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "notes")]
    pub notes: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "preparedBy")]
    pub prepared_by: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "calculatedBy")]
    pub calculated_by: Option<String>,
    #[serde(rename = "calculatedAt", with = "crate::js::timestamp::option")]
    pub calculated_at: Option<TimeDateTime>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "approvedBy")]
    pub approved_by: Option<String>,
    #[serde(rename = "approvedAt", with = "crate::js::timestamp::option")]
    pub approved_at: Option<TimeDateTime>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "paidBy")]
    pub paid_by: Option<String>,
    #[serde(rename = "paidAt", with = "crate::js::timestamp::option")]
    pub paid_at: Option<TimeDateTime>,
    #[serde(rename = "cancelledAt", with = "crate::js::timestamp::option")]
    pub cancelled_at: Option<TimeDateTime>,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "journalStatus")]
    pub journal_status: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "journalEntryId")]
    pub journal_entry_id: Option<String>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "journalError")]
    pub journal_error: Option<String>,
    #[serde(rename = "createdAt", with = "crate::js::timestamp")]
    pub created_at: TimeDateTime,
    #[serde(rename = "updatedAt", with = "crate::js::timestamp")]
    pub updated_at: TimeDateTime,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "hr_pay_runs",
    columns: &[
        DdlColumn {
            name: "kind",
            sql_type: None,
            default: Some(DdlDefault::Sql("'regular'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "status",
            sql_type: None,
            default: Some(DdlDefault::Sql("'draft'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "employee_count",
            sql_type: None,
            default: Some(DdlDefault::Number("0")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "excluded_employee_ids",
            sql_type: None,
            default: Some(DdlDefault::Sql("'[]'::jsonb")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "issues",
            sql_type: None,
            default: Some(DdlDefault::Sql("'[]'::jsonb")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "journal_status",
            sql_type: None,
            default: Some(DdlDefault::Sql("'not_linked'")),
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
            name: "hr_pay_runs_employer_period_idx",
            columns: &[
                IndexColumn {
                    expression: "employer_id",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "period_start",
                    is_expression: false,
                    asc: true,
                },
            ],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "hr_pay_runs_status_idx",
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
            name: "hr_pay_runs_regular_uidx",
            columns: &[
                IndexColumn {
                    expression: "pay_schedule_id",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "period_start",
                    is_expression: false,
                    asc: true,
                },
            ],
            unique: true,
            method: "btree",
            filter: Some("kind = 'regular' AND status <> 'cancelled'"),
        },
    ],
    foreign_keys: &[],
    uniques: &[],
    checks: &[],
};
