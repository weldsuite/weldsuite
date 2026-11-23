//! `commerce_payments`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "commerce_payments")]
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
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "orderId")]
    pub order_id: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "connectionId")]
    pub connection_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "provider")]
    pub provider: String,
    #[sea_orm(column_type = "String(StringLen::N(100))")]
    #[serde(rename = "providerPaymentId")]
    pub provider_payment_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "status")]
    pub status: String,
    #[sea_orm(column_type = "Decimal(Some((18, 2)))")]
    #[serde(
        rename = "amount",
        serialize_with = "crate::js::Numeric::<2>::serialize"
    )]
    pub amount: BigDecimal,
    #[sea_orm(column_type = "String(StringLen::N(3))")]
    #[serde(rename = "currency")]
    pub currency: String,
    #[sea_orm(column_type = "String(StringLen::N(50))")]
    #[serde(rename = "method")]
    pub method: Option<String>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "checkoutUrl")]
    pub checkout_url: Option<String>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "redirectUrl")]
    pub redirect_url: Option<String>,
    #[serde(rename = "testmode")]
    pub testmode: bool,
    #[sea_orm(column_type = "Decimal(Some((18, 2)))")]
    #[serde(
        rename = "amountRefunded",
        serialize_with = "crate::js::Numeric::<2>::serialize"
    )]
    pub amount_refunded: BigDecimal,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "failureReason")]
    pub failure_reason: Option<String>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "providerData")]
    pub provider_data: Option<Json>,
    #[sea_orm(column_type = "String(StringLen::N(100))")]
    #[serde(rename = "idempotencyKey")]
    pub idempotency_key: Option<String>,
    #[serde(rename = "expiresAt", with = "crate::js::timestamp::option")]
    pub expires_at: Option<TimeDateTime>,
    #[serde(rename = "paidAt", with = "crate::js::timestamp::option")]
    pub paid_at: Option<TimeDateTime>,
    #[serde(rename = "failedAt", with = "crate::js::timestamp::option")]
    pub failed_at: Option<TimeDateTime>,
    #[serde(rename = "canceledAt", with = "crate::js::timestamp::option")]
    pub canceled_at: Option<TimeDateTime>,
    #[serde(rename = "expiredAt", with = "crate::js::timestamp::option")]
    pub expired_at: Option<TimeDateTime>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "commerce_payments",
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
            name: "provider",
            sql_type: None,
            default: Some(DdlDefault::Sql("'mollie'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "status",
            sql_type: None,
            default: Some(DdlDefault::Sql("'open'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "testmode",
            sql_type: None,
            default: Some(DdlDefault::Bool(false)),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "amount_refunded",
            sql_type: None,
            default: Some(DdlDefault::Sql("'0'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
    ],
    primary_key: None,
    indexes: &[
        Index {
            name: "commerce_payments_order_idx",
            columns: &[IndexColumn {
                expression: "order_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "commerce_payments_status_idx",
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
            name: "commerce_payments_provider_payment_uidx",
            columns: &[
                IndexColumn {
                    expression: "provider",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "provider_payment_id",
                    is_expression: false,
                    asc: true,
                },
            ],
            unique: true,
            method: "btree",
            filter: Some("\"commerce_payments\".\"provider_payment_id\" IS NOT NULL"),
        },
        Index {
            name: "commerce_payments_idempotency_key_uidx",
            columns: &[IndexColumn {
                expression: "idempotency_key",
                is_expression: false,
                asc: true,
            }],
            unique: true,
            method: "btree",
            filter: Some("\"commerce_payments\".\"idempotency_key\" IS NOT NULL"),
        },
    ],
    foreign_keys: &[],
    uniques: &[],
    checks: &[],
};
