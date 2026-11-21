//! `billing_payments`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "billing_payments")]
pub struct Model {
    #[sea_orm(
        primary_key,
        auto_increment = false,
        column_type = "String(StringLen::N(30))"
    )]
    #[serde(rename = "id")]
    pub id: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "workspaceId")]
    pub workspace_id: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "invoiceId")]
    pub invoice_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "provider")]
    pub provider: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "stripePaymentIntentId")]
    pub stripe_payment_intent_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "stripeChargeId")]
    pub stripe_charge_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "providerPaymentId")]
    pub provider_payment_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "kind")]
    pub kind: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "idempotencyKey")]
    pub idempotency_key: Option<String>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "metadata")]
    pub metadata: Option<Json>,
    #[serde(rename = "paidAt", with = "crate::js::timestamp::option")]
    pub paid_at: Option<TimeDateTime>,
    #[serde(rename = "amount")]
    pub amount: i32,
    #[sea_orm(column_type = "String(StringLen::N(10))")]
    #[serde(rename = "currency")]
    pub currency: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "status")]
    pub status: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "paymentMethodType")]
    pub payment_method_type: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "paymentMethodBrand")]
    pub payment_method_brand: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(4))")]
    #[serde(rename = "paymentMethodLast4")]
    pub payment_method_last4: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(100))")]
    #[serde(rename = "failureCode")]
    pub failure_code: Option<String>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "failureMessage")]
    pub failure_message: Option<String>,
    #[serde(rename = "refundedAmount")]
    pub refunded_amount: i32,
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
    name: "billing_payments",
    columns: &[
        DdlColumn {
            name: "provider",
            sql_type: None,
            default: Some(DdlDefault::Sql("'stripe'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "refunded_amount",
            sql_type: None,
            default: Some(DdlDefault::Number("0")),
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
            name: "billing_payments_workspace_id_idx",
            columns: &[IndexColumn {
                expression: "workspace_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "billing_payments_invoice_id_idx",
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
            name: "billing_payments_status_idx",
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
            name: "billing_payments_created_at_idx",
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
    foreign_keys: &[
        ForeignKey {
            name: "billing_payments_workspace_id_workspaces_id_fk",
            columns: &["workspace_id"],
            references: "workspaces",
            referenced_columns: &["id"],
            on_delete: "cascade",
            on_update: "no action",
        },
        ForeignKey {
            name: "billing_payments_invoice_id_billing_invoices_id_fk",
            columns: &["invoice_id"],
            references: "billing_invoices",
            referenced_columns: &["id"],
            on_delete: "cascade",
            on_update: "no action",
        },
    ],
    uniques: &[
        Unique {
            name: "billing_payments_stripe_payment_intent_id_unique",
            columns: &["stripe_payment_intent_id"],
            nulls_not_distinct: false,
        },
        Unique {
            name: "billing_payments_provider_payment_id_unique",
            columns: &["provider_payment_id"],
            nulls_not_distinct: false,
        },
        Unique {
            name: "billing_payments_idempotency_key_unique",
            columns: &["idempotency_key"],
            nulls_not_distinct: false,
        },
    ],
    checks: &[],
};
