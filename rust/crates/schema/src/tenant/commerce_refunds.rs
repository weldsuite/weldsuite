//! `commerce_refunds`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "commerce_refunds")]
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
    #[serde(rename = "paymentId")]
    pub payment_id: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "provider")]
    pub provider: String,
    #[sea_orm(column_type = "String(StringLen::N(100))")]
    #[serde(rename = "providerRefundId")]
    pub provider_refund_id: Option<String>,
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
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "reason")]
    pub reason: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "creditNoteId")]
    pub credit_note_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "createdBy")]
    pub created_by: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(100))")]
    #[serde(rename = "idempotencyKey")]
    pub idempotency_key: Option<String>,
    #[serde(rename = "refundedAt", with = "crate::js::timestamp::option")]
    pub refunded_at: Option<TimeDateTime>,
    #[serde(rename = "failedAt", with = "crate::js::timestamp::option")]
    pub failed_at: Option<TimeDateTime>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "commerce_refunds",
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
            default: Some(DdlDefault::Sql("'pending'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
    ],
    primary_key: None,
    indexes: &[
        Index {
            name: "commerce_refunds_order_idx",
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
            name: "commerce_refunds_payment_idx",
            columns: &[IndexColumn {
                expression: "payment_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "commerce_refunds_provider_refund_uidx",
            columns: &[
                IndexColumn {
                    expression: "provider",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "provider_refund_id",
                    is_expression: false,
                    asc: true,
                },
            ],
            unique: true,
            method: "btree",
            filter: Some("\"commerce_refunds\".\"provider_refund_id\" IS NOT NULL"),
        },
        Index {
            name: "commerce_refunds_idempotency_key_uidx",
            columns: &[IndexColumn {
                expression: "idempotency_key",
                is_expression: false,
                asc: true,
            }],
            unique: true,
            method: "btree",
            filter: Some("\"commerce_refunds\".\"idempotency_key\" IS NOT NULL"),
        },
    ],
    foreign_keys: &[],
    uniques: &[],
    checks: &[],
};
