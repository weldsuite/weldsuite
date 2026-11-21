//! `hr_shifts`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "hr_shifts")]
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
    #[serde(rename = "startsAt", with = "crate::js::timestamptz")]
    pub starts_at: TimeDateTimeWithTimeZone,
    #[serde(rename = "endsAt", with = "crate::js::timestamptz")]
    pub ends_at: TimeDateTimeWithTimeZone,
    #[sea_orm(column_type = "String(StringLen::N(100))")]
    #[serde(rename = "workType")]
    pub work_type: Option<String>,
    #[serde(rename = "breakStartsAt", with = "crate::js::timestamptz::option")]
    pub break_starts_at: Option<TimeDateTimeWithTimeZone>,
    #[serde(rename = "breakEndsAt", with = "crate::js::timestamptz::option")]
    pub break_ends_at: Option<TimeDateTimeWithTimeZone>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "notes")]
    pub notes: Option<String>,
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
    name: "hr_shifts",
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
    ],
    primary_key: None,
    indexes: &[
        Index {
            name: "hr_shifts_employee_start_idx",
            columns: &[
                IndexColumn {
                    expression: "employee_id",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "starts_at",
                    is_expression: false,
                    asc: true,
                },
            ],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "hr_shifts_start_idx",
            columns: &[IndexColumn {
                expression: "starts_at",
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
