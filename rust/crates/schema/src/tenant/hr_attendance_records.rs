//! `hr_attendance_records`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "hr_attendance_records")]
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
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "companyId")]
    pub company_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "shiftId")]
    pub shift_id: Option<String>,
    #[serde(rename = "date", with = "crate::js::date")]
    pub date: TimeDate,
    #[serde(rename = "clockIn", with = "crate::js::timestamptz::option")]
    pub clock_in: Option<TimeDateTimeWithTimeZone>,
    #[serde(rename = "clockOut", with = "crate::js::timestamptz::option")]
    pub clock_out: Option<TimeDateTimeWithTimeZone>,
    #[serde(rename = "breakMinutes")]
    pub break_minutes: i32,
    #[serde(rename = "workedMinutes")]
    pub worked_minutes: Option<i32>,
    #[serde(rename = "lateMinutes")]
    pub late_minutes: i32,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "status")]
    pub status: String,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "source")]
    pub source: String,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "notes")]
    pub notes: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "approvedBy")]
    pub approved_by: Option<String>,
    #[serde(rename = "approvedAt", with = "crate::js::timestamp::option")]
    pub approved_at: Option<TimeDateTime>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "clockInLocationId")]
    pub clock_in_location_id: Option<String>,
    #[serde(rename = "clockInLatitude")]
    pub clock_in_latitude: Option<f64>,
    #[serde(rename = "clockInLongitude")]
    pub clock_in_longitude: Option<f64>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "clockOutLocationId")]
    pub clock_out_location_id: Option<String>,
    #[serde(rename = "clockOutLatitude")]
    pub clock_out_latitude: Option<f64>,
    #[serde(rename = "clockOutLongitude")]
    pub clock_out_longitude: Option<f64>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "createdBy")]
    pub created_by: Option<String>,
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
    name: "hr_attendance_records",
    columns: &[
        DdlColumn {
            name: "break_minutes",
            sql_type: None,
            default: Some(DdlDefault::Number("0")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "late_minutes",
            sql_type: None,
            default: Some(DdlDefault::Number("0")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "status",
            sql_type: None,
            default: Some(DdlDefault::Sql("'present'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "source",
            sql_type: None,
            default: Some(DdlDefault::Sql("'manual'")),
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
            name: "hr_attendance_employee_date_idx",
            columns: &[
                IndexColumn {
                    expression: "employee_id",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "date",
                    is_expression: false,
                    asc: true,
                },
            ],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "hr_attendance_date_idx",
            columns: &[IndexColumn {
                expression: "date",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "hr_attendance_company_idx",
            columns: &[IndexColumn {
                expression: "company_id",
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
