//! `stash_item_plans`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "stash_item_plans")]
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
    #[sea_orm(column_type = "String(StringLen::N(100))")]
    #[serde(rename = "itemKey")]
    pub item_key: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "productId")]
    pub product_id: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "variantId")]
    pub variant_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "warehouseId")]
    pub warehouse_id: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "runId")]
    pub run_id: Option<String>,
    #[serde(rename = "computedAt", with = "crate::js::timestamp::option")]
    pub computed_at: Option<TimeDateTime>,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "method")]
    pub method: String,
    #[sea_orm(column_type = "String(StringLen::N(10))")]
    #[serde(rename = "confidence")]
    pub confidence: String,
    #[serde(rename = "historyDays")]
    pub history_days: i32,
    #[serde(rename = "nonzeroDays")]
    pub nonzero_days: i32,
    #[sea_orm(column_type = "Decimal(Some((14, 4)))")]
    #[serde(
        rename = "avgDailyDemand",
        serialize_with = "crate::js::Numeric::<4>::serialize_option"
    )]
    pub avg_daily_demand: Option<BigDecimal>,
    #[sea_orm(column_type = "Decimal(Some((14, 4)))")]
    #[serde(
        rename = "demandStdDev",
        serialize_with = "crate::js::Numeric::<4>::serialize_option"
    )]
    pub demand_std_dev: Option<BigDecimal>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "seasonality")]
    pub seasonality: Option<Json>,
    #[sea_orm(column_type = "Decimal(Some((14, 4)))")]
    #[serde(
        rename = "forecast30d",
        serialize_with = "crate::js::Numeric::<4>::serialize_option"
    )]
    pub forecast_30d: Option<BigDecimal>,
    #[sea_orm(column_type = "Decimal(Some((14, 4)))")]
    #[serde(
        rename = "forecast90d",
        serialize_with = "crate::js::Numeric::<4>::serialize_option"
    )]
    pub forecast_90d: Option<BigDecimal>,
    #[serde(rename = "leadTimeDays")]
    pub lead_time_days: Option<i32>,
    #[serde(rename = "reviewPeriodDays")]
    pub review_period_days: Option<i32>,
    #[sea_orm(column_type = "Decimal(Some((4, 3)))")]
    #[serde(
        rename = "serviceLevel",
        serialize_with = "crate::js::Numeric::<3>::serialize_option"
    )]
    pub service_level: Option<BigDecimal>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "productSupplierId")]
    pub product_supplier_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "supplierId")]
    pub supplier_id: Option<String>,
    #[serde(rename = "safetyStock")]
    pub safety_stock: Option<i32>,
    #[serde(rename = "reorderPoint")]
    pub reorder_point: Option<i32>,
    #[serde(rename = "orderUpTo")]
    pub order_up_to: Option<i32>,
    #[serde(rename = "onHand")]
    pub on_hand: i32,
    #[serde(rename = "allocated")]
    pub allocated: i32,
    #[serde(rename = "incoming")]
    pub incoming: i32,
    #[serde(rename = "openDemand")]
    pub open_demand: i32,
    #[serde(rename = "inventoryPosition")]
    pub inventory_position: i32,
    #[sea_orm(column_type = "Decimal(Some((10, 1)))")]
    #[serde(
        rename = "daysOfCover",
        serialize_with = "crate::js::Numeric::<1>::serialize_option"
    )]
    pub days_of_cover: Option<BigDecimal>,
    #[serde(rename = "stockoutDate", with = "crate::js::date::option")]
    pub stockout_date: Option<TimeDate>,
    #[serde(rename = "suggestedQty")]
    pub suggested_qty: i32,
    #[sea_orm(column_type = "Decimal(Some((18, 2)))")]
    #[serde(
        rename = "suggestedValue",
        serialize_with = "crate::js::Numeric::<2>::serialize_option"
    )]
    pub suggested_value: Option<BigDecimal>,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "reviewStatus")]
    pub review_status: String,
    #[serde(rename = "dismissedUntil", with = "crate::js::timestamp::option")]
    pub dismissed_until: Option<TimeDateTime>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "dismissedBy")]
    pub dismissed_by: Option<String>,
    #[serde(rename = "dismissedQty")]
    pub dismissed_qty: Option<i32>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "purchaseOrderId")]
    pub purchase_order_id: Option<String>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "stash_item_plans",
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
            name: "method",
            sql_type: None,
            default: Some(DdlDefault::Sql("'none'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "confidence",
            sql_type: None,
            default: Some(DdlDefault::Sql("'none'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "history_days",
            sql_type: None,
            default: Some(DdlDefault::Number("0")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "nonzero_days",
            sql_type: None,
            default: Some(DdlDefault::Number("0")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "on_hand",
            sql_type: None,
            default: Some(DdlDefault::Number("0")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "allocated",
            sql_type: None,
            default: Some(DdlDefault::Number("0")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "incoming",
            sql_type: None,
            default: Some(DdlDefault::Number("0")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "open_demand",
            sql_type: None,
            default: Some(DdlDefault::Number("0")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "inventory_position",
            sql_type: None,
            default: Some(DdlDefault::Number("0")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "suggested_qty",
            sql_type: None,
            default: Some(DdlDefault::Number("0")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "review_status",
            sql_type: None,
            default: Some(DdlDefault::Sql("'none'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
    ],
    primary_key: None,
    indexes: &[
        Index {
            name: "stash_item_plans_item_unique",
            columns: &[IndexColumn {
                expression: "item_key",
                is_expression: false,
                asc: true,
            }],
            unique: true,
            method: "btree",
            filter: None,
        },
        Index {
            name: "stash_item_plans_review_idx",
            columns: &[IndexColumn {
                expression: "review_status",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "stash_item_plans_supplier_idx",
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
            name: "stash_item_plans_warehouse_idx",
            columns: &[IndexColumn {
                expression: "warehouse_id",
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
