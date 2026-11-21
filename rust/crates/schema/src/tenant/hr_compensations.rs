//! `hr_compensations`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "hr_compensations")]
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
    #[serde(rename = "effectiveFrom", with = "crate::js::date")]
    pub effective_from: TimeDate,
    #[serde(rename = "effectiveTo", with = "crate::js::date::option")]
    pub effective_to: Option<TimeDate>,
    #[sea_orm(column_type = "String(StringLen::N(10))")]
    #[serde(rename = "payType")]
    pub pay_type: String,
    #[sea_orm(column_type = "Decimal(Some((14, 4)))")]
    #[serde(
        rename = "amount",
        serialize_with = "crate::js::Numeric::<4>::serialize"
    )]
    pub amount: BigDecimal,
    #[sea_orm(column_type = "String(StringLen::N(10))")]
    #[serde(rename = "period")]
    pub period: String,
    #[sea_orm(column_type = "String(StringLen::N(3))")]
    #[serde(rename = "currency")]
    pub currency: String,
    #[serde(rename = "hoursPerWeek")]
    pub hours_per_week: Option<f64>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "reason")]
    pub reason: Option<String>,
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
    name: "hr_compensations",
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
        name: "hr_compensations_employee_idx",
        columns: &[
            IndexColumn {
                expression: "employee_id",
                is_expression: false,
                asc: true,
            },
            IndexColumn {
                expression: "effective_from",
                is_expression: false,
                asc: true,
            },
        ],
        unique: false,
        method: "btree",
        filter: None,
    }],
    foreign_keys: &[],
    uniques: &[],
    checks: &[],
};
