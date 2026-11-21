//! `discounts`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "discounts")]
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
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "name")]
    pub name: String,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "description")]
    pub description: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(100))")]
    #[serde(rename = "code")]
    pub code: Option<String>,
    #[sea_orm(column_name = "type", column_type = "String(StringLen::N(30))")]
    #[serde(rename = "type")]
    pub type_: String,
    #[sea_orm(column_type = "Decimal(Some((18, 2)))")]
    #[serde(
        rename = "value",
        serialize_with = "crate::js::Numeric::<2>::serialize"
    )]
    pub value: BigDecimal,
    #[sea_orm(column_type = "String(StringLen::N(3))")]
    #[serde(rename = "currency")]
    pub currency: Option<String>,
    #[sea_orm(column_type = "Decimal(Some((18, 2)))")]
    #[serde(
        rename = "maxDiscountAmount",
        serialize_with = "crate::js::Numeric::<2>::serialize_option"
    )]
    pub max_discount_amount: Option<BigDecimal>,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "appliesTo")]
    pub applies_to: String,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "productIds")]
    pub product_ids: Option<Json>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "variantIds")]
    pub variant_ids: Option<Json>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "categoryIds")]
    pub category_ids: Option<Json>,
    #[sea_orm(column_type = "Decimal(Some((18, 2)))")]
    #[serde(
        rename = "minimumSubtotal",
        serialize_with = "crate::js::Numeric::<2>::serialize_option"
    )]
    pub minimum_subtotal: Option<BigDecimal>,
    #[serde(rename = "minimumQuantity")]
    pub minimum_quantity: Option<i32>,
    #[serde(rename = "usageLimit")]
    pub usage_limit: Option<i32>,
    #[serde(rename = "usageLimitPerCustomer")]
    pub usage_limit_per_customer: Option<i32>,
    #[serde(rename = "usageCount")]
    pub usage_count: Option<i32>,
    #[serde(rename = "oncePerCustomer")]
    pub once_per_customer: Option<bool>,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "customerEligibility")]
    pub customer_eligibility: Option<String>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "customerIds")]
    pub customer_ids: Option<Json>,
    #[serde(rename = "combinesWithOtherDiscounts")]
    pub combines_with_other_discounts: Option<bool>,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "status")]
    pub status: String,
    #[serde(rename = "startsAt", with = "crate::js::timestamp::option")]
    pub starts_at: Option<TimeDateTime>,
    #[serde(rename = "endsAt", with = "crate::js::timestamp::option")]
    pub ends_at: Option<TimeDateTime>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "customFields")]
    pub custom_fields: Option<Json>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "createdBy")]
    pub created_by: Option<String>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "discounts",
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
            name: "value",
            sql_type: None,
            default: Some(DdlDefault::Sql("'0'")),
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
            name: "applies_to",
            sql_type: None,
            default: Some(DdlDefault::Sql("'all'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "usage_count",
            sql_type: None,
            default: Some(DdlDefault::Number("0")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "once_per_customer",
            sql_type: None,
            default: Some(DdlDefault::Bool(false)),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "customer_eligibility",
            sql_type: None,
            default: Some(DdlDefault::Sql("'all'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "combines_with_other_discounts",
            sql_type: None,
            default: Some(DdlDefault::Bool(false)),
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
    ],
    primary_key: None,
    indexes: &[
        Index {
            name: "discounts_code_idx",
            columns: &[IndexColumn {
                expression: "code",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "discounts_status_idx",
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
            name: "discounts_type_idx",
            columns: &[IndexColumn {
                expression: "type",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "discounts_ends_at_idx",
            columns: &[IndexColumn {
                expression: "ends_at",
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
