//! `billing_invoices`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "billing_invoices")]
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
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "provider")]
    pub provider: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "stripeInvoiceId")]
    pub stripe_invoice_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "stripeCustomerId")]
    pub stripe_customer_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "stripeSubscriptionId")]
    pub stripe_subscription_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "providerInvoiceId")]
    pub provider_invoice_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "providerPaymentId")]
    pub provider_payment_id: Option<String>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "lines")]
    pub lines: Option<Json>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "documentKey")]
    pub document_key: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(100))")]
    #[serde(rename = "number")]
    pub number: Option<String>,
    #[serde(rename = "amountDue")]
    pub amount_due: Option<i32>,
    #[serde(rename = "amountPaid")]
    pub amount_paid: Option<i32>,
    #[sea_orm(column_type = "String(StringLen::N(10))")]
    #[serde(rename = "currency")]
    pub currency: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "status")]
    pub status: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(50))")]
    #[serde(rename = "billingReason")]
    pub billing_reason: Option<String>,
    #[serde(rename = "periodStart", with = "crate::js::timestamp::option")]
    pub period_start: Option<TimeDateTime>,
    #[serde(rename = "periodEnd", with = "crate::js::timestamp::option")]
    pub period_end: Option<TimeDateTime>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "pdfUrl")]
    pub pdf_url: Option<String>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "hostedUrl")]
    pub hosted_url: Option<String>,
    #[serde(rename = "taxAmount")]
    pub tax_amount: Option<i32>,
    #[serde(rename = "subtotalAmount")]
    pub subtotal_amount: Option<i32>,
    #[sea_orm(column_type = "String(StringLen::N(2))")]
    #[serde(rename = "customerCountry")]
    pub customer_country: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "customerTaxExempt")]
    pub customer_tax_exempt: Option<String>,
    #[serde(rename = "paidAt", with = "crate::js::timestamp::option")]
    pub paid_at: Option<TimeDateTime>,
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
    name: "billing_invoices",
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
            name: "billing_invoices_workspace_id_idx",
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
            name: "billing_invoices_stripe_customer_id_idx",
            columns: &[IndexColumn {
                expression: "stripe_customer_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "billing_invoices_status_idx",
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
            name: "billing_invoices_created_at_idx",
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
    foreign_keys: &[ForeignKey {
        name: "billing_invoices_workspace_id_workspaces_id_fk",
        columns: &["workspace_id"],
        references: "workspaces",
        referenced_columns: &["id"],
        on_delete: "cascade",
        on_update: "no action",
    }],
    uniques: &[
        Unique {
            name: "billing_invoices_stripe_invoice_id_unique",
            columns: &["stripe_invoice_id"],
            nulls_not_distinct: false,
        },
        Unique {
            name: "billing_invoices_provider_payment_id_unique",
            columns: &["provider_payment_id"],
            nulls_not_distinct: false,
        },
    ],
    checks: &[],
};
