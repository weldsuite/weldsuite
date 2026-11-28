//! `invoice_items`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "invoice_items")]
pub struct Model {
    #[sea_orm(
        primary_key,
        auto_increment = false,
        column_type = "String(StringLen::N(30))"
    )]
    #[serde(rename = "id")]
    pub id: String,
    #[serde(rename = "createdAt", with = "crate::js::timestamp")]
    pub created_at: TimeDateTime,
    #[serde(rename = "updatedAt", with = "crate::js::timestamp")]
    pub updated_at: TimeDateTime,
    #[serde(rename = "deletedAt", with = "crate::js::timestamp::option")]
    pub deleted_at: Option<TimeDateTime>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "entityId")]
    pub entity_id: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "invoiceId")]
    pub invoice_id: String,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "description")]
    pub description: String,
    #[sea_orm(column_type = "Decimal(Some((10, 4)))")]
    #[serde(
        rename = "quantity",
        serialize_with = "crate::js::Numeric::<4>::serialize_option"
    )]
    pub quantity: Option<BigDecimal>,
    #[sea_orm(column_type = "Decimal(Some((18, 4)))")]
    #[serde(
        rename = "unitPrice",
        serialize_with = "crate::js::Numeric::<4>::serialize"
    )]
    pub unit_price: BigDecimal,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "unit")]
    pub unit: Option<String>,
    #[sea_orm(column_type = "Decimal(Some((5, 2)))")]
    #[serde(
        rename = "discountPercent",
        serialize_with = "crate::js::Numeric::<2>::serialize_option"
    )]
    pub discount_percent: Option<BigDecimal>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "taxRateId")]
    pub tax_rate_id: Option<String>,
    #[sea_orm(column_type = "Decimal(Some((7, 4)))")]
    #[serde(
        rename = "taxRate",
        serialize_with = "crate::js::Numeric::<4>::serialize_option"
    )]
    pub tax_rate: Option<BigDecimal>,
    #[sea_orm(column_type = "Decimal(Some((18, 2)))")]
    #[serde(
        rename = "taxAmount",
        serialize_with = "crate::js::Numeric::<2>::serialize_option"
    )]
    pub tax_amount: Option<BigDecimal>,
    #[sea_orm(column_type = "Decimal(Some((18, 2)))")]
    #[serde(
        rename = "lineTotal",
        serialize_with = "crate::js::Numeric::<2>::serialize_option"
    )]
    pub line_total: Option<BigDecimal>,
    #[sea_orm(column_type = "Decimal(Some((18, 2)))")]
    #[serde(
        rename = "lineTotalWithTax",
        serialize_with = "crate::js::Numeric::<2>::serialize_option"
    )]
    pub line_total_with_tax: Option<BigDecimal>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "accountId")]
    pub account_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "productId")]
    pub product_id: Option<String>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "period")]
    pub period: Option<Json>,
    #[serde(rename = "sortOrder")]
    pub sort_order: Option<i32>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "taxCode")]
    pub tax_code: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(10))")]
    #[serde(rename = "taxUse")]
    pub tax_use: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(10))")]
    #[serde(rename = "hsnSac")]
    pub hsn_sac: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(8))")]
    #[serde(rename = "ncm")]
    pub ncm: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(4))")]
    #[serde(rename = "cfop")]
    pub cfop: Option<String>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "fiscalData")]
    pub fiscal_data: Option<Json>,
    #[serde(rename = "taxIncluded")]
    pub tax_included: Option<bool>,
    #[sea_orm(column_type = "Decimal(Some((18, 2)))")]
    #[serde(
        rename = "taxOverrideAmount",
        serialize_with = "crate::js::Numeric::<2>::serialize_option"
    )]
    pub tax_override_amount: Option<BigDecimal>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "taxOverrideReason")]
    pub tax_override_reason: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "classId")]
    pub class_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "locationId")]
    pub location_id: Option<String>,
    // WeldBooks phase 6 (plan weldbooks-connected-ux, M4). Rust only: left out
    // of the JSON while unset.
    /// The WeldFlow project the line bills (`projects.id`).
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "projectId", skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "invoice_items",
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
        DdlColumn {
            name: "quantity",
            sql_type: None,
            default: Some(DdlDefault::Sql("'1'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "discount_percent",
            sql_type: None,
            default: Some(DdlDefault::Sql("'0'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "sort_order",
            sql_type: None,
            default: Some(DdlDefault::Number("0")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "tax_included",
            sql_type: None,
            default: Some(DdlDefault::Bool(false)),
            generated: None,
            default_fn: false,
            on_update: false,
        },
    ],
    primary_key: None,
    indexes: &[
        Index {
            name: "acct_invoice_items_entity_idx",
            columns: &[IndexColumn {
                expression: "entity_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "acct_invoice_items_invoice_idx",
            columns: &[IndexColumn {
                expression: "invoice_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "acct_invoice_items_project_idx",
            columns: &[IndexColumn {
                expression: "project_id",
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
