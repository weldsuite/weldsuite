//! `stash_reorder_rules`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "stash_reorder_rules")]
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
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "method")]
    pub method: String,
    #[serde(rename = "minQty")]
    pub min_qty: Option<i32>,
    #[serde(rename = "maxQty")]
    pub max_qty: Option<i32>,
    #[sea_orm(column_type = "Decimal(Some((4, 3)))")]
    #[serde(
        rename = "serviceLevel",
        serialize_with = "crate::js::Numeric::<3>::serialize_option"
    )]
    pub service_level: Option<BigDecimal>,
    #[serde(rename = "reviewPeriodDays")]
    pub review_period_days: Option<i32>,
    #[serde(rename = "leadTimeDaysOverride")]
    pub lead_time_days_override: Option<i32>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "productSupplierId")]
    pub product_supplier_id: Option<String>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "stash_reorder_rules",
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
            default: Some(DdlDefault::Sql("'auto'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
    ],
    primary_key: None,
    indexes: &[
        Index {
            name: "stash_reorder_rules_item_unique",
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
            name: "stash_reorder_rules_product_idx",
            columns: &[IndexColumn {
                expression: "product_id",
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
