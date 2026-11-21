//! `telephony_number_pricing`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "telephony_number_pricing")]
pub struct Model {
    #[sea_orm(
        primary_key,
        auto_increment = false,
        column_type = "String(StringLen::N(30))"
    )]
    #[serde(rename = "id")]
    pub id: String,
    #[sea_orm(column_type = "String(StringLen::N(5))")]
    #[serde(rename = "countryCode")]
    pub country_code: String,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "numberType")]
    pub number_type: String,
    #[sea_orm(column_type = "Decimal(Some((10, 2)))")]
    #[serde(
        rename = "monthlyPrice",
        serialize_with = "crate::js::Numeric::<2>::serialize"
    )]
    pub monthly_price: BigDecimal,
    #[sea_orm(column_type = "Decimal(Some((10, 2)))")]
    #[serde(
        rename = "setupFee",
        serialize_with = "crate::js::Numeric::<2>::serialize"
    )]
    pub setup_fee: BigDecimal,
    #[sea_orm(column_type = "String(StringLen::N(3))")]
    #[serde(rename = "currency")]
    pub currency: String,
    #[sea_orm(column_type = "String(StringLen::N(50))")]
    #[serde(rename = "provider")]
    pub provider: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "stripePriceId")]
    pub stripe_price_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "stripeProductId")]
    pub stripe_product_id: Option<String>,
    #[serde(rename = "markupAmount")]
    pub markup_amount: Option<i32>,
    #[sea_orm(column_type = "Decimal(Some((5, 2)))")]
    #[serde(
        rename = "markupPercent",
        serialize_with = "crate::js::Numeric::<2>::serialize_option"
    )]
    pub markup_percent: Option<BigDecimal>,
    #[serde(rename = "isActive")]
    pub is_active: bool,
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
    name: "telephony_number_pricing",
    columns: &[
        DdlColumn {
            name: "setup_fee",
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
            name: "provider",
            sql_type: None,
            default: Some(DdlDefault::Sql("'twilio'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "is_active",
            sql_type: None,
            default: Some(DdlDefault::Bool(true)),
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
            name: "telephony_number_pricing_country_type_idx",
            columns: &[
                IndexColumn {
                    expression: "country_code",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "number_type",
                    is_expression: false,
                    asc: true,
                },
            ],
            unique: true,
            method: "btree",
            filter: None,
        },
        Index {
            name: "telephony_number_pricing_country_code_idx",
            columns: &[IndexColumn {
                expression: "country_code",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "telephony_number_pricing_is_active_idx",
            columns: &[IndexColumn {
                expression: "is_active",
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
