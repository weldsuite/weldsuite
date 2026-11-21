//! `hr_absences`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "hr_absences")]
pub struct Model {
    #[sea_orm(
        primary_key,
        auto_increment = false,
        column_type = "String(StringLen::N(30))"
    )]
    #[serde(rename = "id")]
    pub id: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "employeeId")]
    pub employee_id: String,
    #[serde(rename = "startDate", with = "crate::js::date")]
    pub start_date: TimeDate,
    #[serde(rename = "endDate", with = "crate::js::date::option")]
    pub end_date: Option<TimeDate>,
    #[sea_orm(column_type = "String(StringLen::N(10))")]
    #[serde(rename = "firstDay")]
    pub first_day: String,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "note")]
    pub note: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "reportedBy")]
    pub reported_by: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "recoveredReportedBy")]
    pub recovered_reported_by: Option<String>,
    #[serde(rename = "recoveredReportedAt", with = "crate::js::timestamp::option")]
    pub recovered_reported_at: Option<TimeDateTime>,
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
    name: "hr_absences",
    columns: &[
        DdlColumn {
            name: "first_day",
            sql_type: None,
            default: Some(DdlDefault::Sql("'full'")),
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
            name: "hr_absences_employee_start_idx",
            columns: &[
                IndexColumn {
                    expression: "employee_id",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "start_date",
                    is_expression: false,
                    asc: true,
                },
            ],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "hr_absences_end_idx",
            columns: &[IndexColumn {
                expression: "end_date",
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
