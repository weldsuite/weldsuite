//! `purchase_orders`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "purchase_orders")]
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
    #[sea_orm(column_type = "String(StringLen::N(50))")]
    #[serde(rename = "poNumber")]
    pub po_number: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "supplierId")]
    pub supplier_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "supplierName")]
    pub supplier_name: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "warehouseId")]
    pub warehouse_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "warehouseName")]
    pub warehouse_name: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "status")]
    pub status: String,
    #[serde(rename = "orderDate", with = "crate::js::timestamp::option")]
    pub order_date: Option<TimeDateTime>,
    #[serde(rename = "expectedDate", with = "crate::js::timestamp::option")]
    pub expected_date: Option<TimeDateTime>,
    #[serde(rename = "receivedDate", with = "crate::js::timestamp::option")]
    pub received_date: Option<TimeDateTime>,
    #[sea_orm(column_type = "String(StringLen::N(3))")]
    #[serde(rename = "currency")]
    pub currency: Option<String>,
    #[sea_orm(column_type = "Decimal(Some((18, 2)))")]
    #[serde(
        rename = "subtotal",
        serialize_with = "crate::js::Numeric::<2>::serialize_option"
    )]
    pub subtotal: Option<BigDecimal>,
    #[sea_orm(column_type = "Decimal(Some((18, 2)))")]
    #[serde(
        rename = "taxTotal",
        serialize_with = "crate::js::Numeric::<2>::serialize_option"
    )]
    pub tax_total: Option<BigDecimal>,
    #[sea_orm(column_type = "Decimal(Some((18, 2)))")]
    #[serde(
        rename = "shippingTotal",
        serialize_with = "crate::js::Numeric::<2>::serialize_option"
    )]
    pub shipping_total: Option<BigDecimal>,
    #[sea_orm(column_type = "Decimal(Some((18, 2)))")]
    #[serde(
        rename = "discountTotal",
        serialize_with = "crate::js::Numeric::<2>::serialize_option"
    )]
    pub discount_total: Option<BigDecimal>,
    #[sea_orm(column_type = "Decimal(Some((18, 2)))")]
    #[serde(
        rename = "total",
        serialize_with = "crate::js::Numeric::<2>::serialize_option"
    )]
    pub total: Option<BigDecimal>,
    #[serde(rename = "itemCount")]
    pub item_count: Option<i32>,
    #[serde(rename = "totalQuantityOrdered")]
    pub total_quantity_ordered: Option<i32>,
    #[serde(rename = "totalQuantityReceived")]
    pub total_quantity_received: Option<i32>,
    #[sea_orm(column_type = "String(StringLen::N(100))")]
    #[serde(rename = "shippingMethod")]
    pub shipping_method: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "trackingNumber")]
    pub tracking_number: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(100))")]
    #[serde(rename = "paymentTerms")]
    pub payment_terms: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "paymentStatus")]
    pub payment_status: Option<String>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "supplierNotes")]
    pub supplier_notes: Option<String>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "internalNotes")]
    pub internal_notes: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "approvedBy")]
    pub approved_by: Option<String>,
    #[serde(rename = "approvedAt", with = "crate::js::timestamp::option")]
    pub approved_at: Option<TimeDateTime>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "createdBy")]
    pub created_by: Option<String>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "metadata")]
    pub metadata: Option<Json>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "tags")]
    pub tags: Option<Json>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "purchase_orders",
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
            name: "status",
            sql_type: None,
            default: Some(DdlDefault::Sql("'draft'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "currency",
            sql_type: None,
            default: Some(DdlDefault::Sql("'USD'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "subtotal",
            sql_type: None,
            default: Some(DdlDefault::Sql("'0'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "tax_total",
            sql_type: None,
            default: Some(DdlDefault::Sql("'0'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "shipping_total",
            sql_type: None,
            default: Some(DdlDefault::Sql("'0'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "discount_total",
            sql_type: None,
            default: Some(DdlDefault::Sql("'0'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "total",
            sql_type: None,
            default: Some(DdlDefault::Sql("'0'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "item_count",
            sql_type: None,
            default: Some(DdlDefault::Number("0")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "total_quantity_ordered",
            sql_type: None,
            default: Some(DdlDefault::Number("0")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "total_quantity_received",
            sql_type: None,
            default: Some(DdlDefault::Number("0")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "payment_status",
            sql_type: None,
            default: Some(DdlDefault::Sql("'pending'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
    ],
    primary_key: None,
    indexes: &[
        Index {
            name: "purchase_orders_po_number_idx",
            columns: &[IndexColumn {
                expression: "po_number",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "purchase_orders_supplier_idx",
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
            name: "purchase_orders_warehouse_idx",
            columns: &[IndexColumn {
                expression: "warehouse_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "purchase_orders_status_idx",
            columns: &[IndexColumn {
                expression: "status",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "purchase_orders_created_idx",
            columns: &[IndexColumn {
                expression: "created_at",
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
