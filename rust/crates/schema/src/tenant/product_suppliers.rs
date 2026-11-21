//! `product_suppliers`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "product_suppliers")]
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
    #[serde(rename = "productId")]
    pub product_id: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "variantId")]
    pub variant_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "supplierId")]
    pub supplier_id: String,
    #[sea_orm(column_type = "String(StringLen::N(100))")]
    #[serde(rename = "supplierSku")]
    pub supplier_sku: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "supplierProductName")]
    pub supplier_product_name: Option<String>,
    #[sea_orm(column_type = "Decimal(Some((18, 4)))")]
    #[serde(
        rename = "unitCost",
        serialize_with = "crate::js::Numeric::<4>::serialize_option"
    )]
    pub unit_cost: Option<BigDecimal>,
    #[sea_orm(column_type = "String(StringLen::N(3))")]
    #[serde(rename = "currency")]
    pub currency: Option<String>,
    #[serde(rename = "leadTimeDays")]
    pub lead_time_days: Option<i32>,
    #[serde(rename = "minOrderQty")]
    pub min_order_qty: Option<i32>,
    #[serde(rename = "orderMultiple")]
    pub order_multiple: i32,
    #[serde(rename = "isPreferred")]
    pub is_preferred: bool,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "metadata")]
    pub metadata: Option<Json>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "product_suppliers",
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
            name: "order_multiple",
            sql_type: None,
            default: Some(DdlDefault::Number("1")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "is_preferred",
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
            name: "product_suppliers_product_idx",
            columns: &[IndexColumn {
                expression: "product_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "product_suppliers_supplier_idx",
            columns: &[IndexColumn {
                expression: "supplier_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "product_suppliers_unique",
            columns: &[
                IndexColumn {
                    expression: "product_id",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "coalesce(\"variant_id\", '')",
                    is_expression: true,
                    asc: true,
                },
                IndexColumn {
                    expression: "supplier_id",
                    is_expression: false,
                    asc: true,
                },
            ],
            unique: true,
            method: "btree",
            filter: Some("deleted_at IS NULL"),
        },
    ],
    foreign_keys: &[],
    uniques: &[],
    checks: &[],
};
