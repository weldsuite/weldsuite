//! `hr_kpi_values`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "hr_kpi_values")]
pub struct Model {
    #[sea_orm(
        primary_key,
        auto_increment = false,
        column_type = "String(StringLen::N(30))"
    )]
    #[serde(rename = "id")]
    pub id: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "kpiId")]
    pub kpi_id: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "employeeId")]
    pub employee_id: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "companyId")]
    pub company_id: Option<String>,
    #[serde(rename = "periodStart", with = "crate::js::date")]
    pub period_start: TimeDate,
    #[serde(rename = "periodEnd", with = "crate::js::date")]
    pub period_end: TimeDate,
    #[serde(rename = "value")]
    pub value: f64,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "source")]
    pub source: String,
    #[serde(rename = "sharedWithClient")]
    pub shared_with_client: bool,
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
    name: "hr_kpi_values",
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
            name: "shared_with_client",
            sql_type: None,
            default: Some(DdlDefault::Bool(false)),
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
            name: "hr_kpi_values_employee_idx",
            columns: &[
                IndexColumn {
                    expression: "employee_id",
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
            name: "hr_kpi_values_kpi_idx",
            columns: &[
                IndexColumn {
                    expression: "kpi_id",
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
            name: "hr_kpi_values_company_idx",
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
