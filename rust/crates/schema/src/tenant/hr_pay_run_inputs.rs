//! `hr_pay_run_inputs`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "hr_pay_run_inputs")]
pub struct Model {
    #[sea_orm(
        primary_key,
        auto_increment = false,
        column_type = "String(StringLen::N(30))"
    )]
    #[serde(rename = "id")]
    pub id: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "runId")]
    pub run_id: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "employeeId")]
    pub employee_id: String,
    #[sea_orm(column_type = "String(StringLen::N(60))")]
    #[serde(rename = "code")]
    pub code: String,
    #[sea_orm(column_type = "String(StringLen::N(160))")]
    #[serde(rename = "label")]
    pub label: Option<String>,
    #[sea_orm(column_type = "Decimal(Some((12, 4)))")]
    #[serde(
        rename = "quantity",
        serialize_with = "crate::js::Numeric::<4>::serialize_option"
    )]
    pub quantity: Option<BigDecimal>,
    #[sea_orm(column_type = "Decimal(Some((14, 4)))")]
    #[serde(
        rename = "rate",
        serialize_with = "crate::js::Numeric::<4>::serialize_option"
    )]
    pub rate: Option<BigDecimal>,
    #[sea_orm(column_type = "Decimal(Some((14, 2)))")]
    #[serde(
        rename = "amount",
        serialize_with = "crate::js::Numeric::<2>::serialize_option"
    )]
    pub amount: Option<BigDecimal>,
    #[serde(rename = "workDate", with = "crate::js::date::option")]
    pub work_date: Option<TimeDate>,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "source")]
    pub source: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "sourceRef")]
    pub source_ref: Option<String>,
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
    name: "hr_pay_run_inputs",
    columns: &[
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
            name: "hr_pay_run_inputs_run_idx",
            columns: &[
                IndexColumn {
                    expression: "run_id",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "employee_id",
                    is_expression: false,
                    asc: true,
                },
            ],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "hr_pay_run_inputs_source_idx",
            columns: &[
                IndexColumn {
                    expression: "source",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "source_ref",
                    is_expression: false,
                    asc: true,
                },
            ],
            unique: false,
            method: "btree",
            filter: None,
        },
    ],
    foreign_keys: &[],
    uniques: &[],
    checks: &[],
};
