//! `hr_payroll_filings`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "hr_payroll_filings")]
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
    #[sea_orm(column_type = "String(StringLen::N(2))")]
    #[serde(rename = "country")]
    pub country: String,
    #[sea_orm(column_type = "String(StringLen::N(40))")]
    #[serde(rename = "kind")]
    pub kind: String,
    #[sea_orm(column_type = "String(StringLen::N(2))")]
    #[serde(rename = "state")]
    pub state: Option<String>,
    #[serde(rename = "taxYear")]
    pub tax_year: i32,
    #[serde(rename = "period")]
    pub period: i32,
    #[serde(rename = "periodStart", with = "crate::js::date")]
    pub period_start: TimeDate,
    #[serde(rename = "periodEnd", with = "crate::js::date")]
    pub period_end: TimeDate,
    #[serde(rename = "dueDate", with = "crate::js::date::option")]
    pub due_date: Option<TimeDate>,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "status")]
    pub status: String,
    #[serde(rename = "version")]
    pub version: i32,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "summary")]
    pub summary: Json,
    #[sea_orm(column_type = "Decimal(Some((14, 2)))")]
    #[serde(
        rename = "amountDue",
        serialize_with = "crate::js::Numeric::<2>::serialize"
    )]
    pub amount_due: BigDecimal,
    #[sea_orm(column_type = "String(StringLen::N(40))")]
    #[serde(rename = "paymentReference")]
    pub payment_reference: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(500))")]
    #[serde(rename = "fileKey")]
    pub file_key: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "fileName")]
    pub file_name: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(120))")]
    #[serde(rename = "contentType")]
    pub content_type: Option<String>,
    #[serde(rename = "generatedAt", with = "crate::js::timestamp::option")]
    pub generated_at: Option<TimeDateTime>,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "channel")]
    pub channel: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(120))")]
    #[serde(rename = "externalReference")]
    pub external_reference: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "submittedBy")]
    pub submitted_by: Option<String>,
    #[serde(rename = "submittedAt", with = "crate::js::timestamp::option")]
    pub submitted_at: Option<TimeDateTime>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "history")]
    pub history: Json,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "issues")]
    pub issues: Json,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "taxPayments")]
    pub tax_payments: Json,
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
    name: "hr_payroll_filings",
    columns: &[
        DdlColumn {
            name: "status",
            sql_type: None,
            default: Some(DdlDefault::Sql("'open'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "version",
            sql_type: None,
            default: Some(DdlDefault::Number("1")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "summary",
            sql_type: None,
            default: Some(DdlDefault::Sql("'{}'::jsonb")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "amount_due",
            sql_type: None,
            default: Some(DdlDefault::Sql("'0'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "history",
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
            name: "tax_payments",
            sql_type: None,
            default: Some(DdlDefault::Sql("'[]'::jsonb")),
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
            name: "hr_payroll_filings_period_uidx",
            columns: &[
                IndexColumn {
                    expression: "employer_id",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "kind",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "tax_year",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "period",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "coalesce(\"state\", '')",
                    is_expression: true,
                    asc: true,
                },
            ],
            unique: true,
            method: "btree",
            filter: None,
        },
        Index {
            name: "hr_payroll_filings_status_idx",
            columns: &[
                IndexColumn {
                    expression: "status",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "due_date",
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
