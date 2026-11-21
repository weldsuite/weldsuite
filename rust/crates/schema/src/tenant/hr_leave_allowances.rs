//! `hr_leave_allowances`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "hr_leave_allowances")]
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
    #[serde(rename = "leaveTypeId")]
    pub leave_type_id: String,
    #[serde(rename = "year")]
    pub year: i32,
    #[serde(rename = "days")]
    pub days: f64,
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
    name: "hr_leave_allowances",
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
    indexes: &[Index {
        name: "hr_leave_allowances_uidx",
        columns: &[
            IndexColumn {
                expression: "employee_id",
                is_expression: false,
                asc: true,
            },
            IndexColumn {
                expression: "leave_type_id",
                is_expression: false,
                asc: true,
            },
            IndexColumn {
                expression: "year",
                is_expression: false,
                asc: true,
            },
        ],
        unique: true,
        method: "btree",
        filter: None,
    }],
    foreign_keys: &[],
    uniques: &[],
    checks: &[],
};
