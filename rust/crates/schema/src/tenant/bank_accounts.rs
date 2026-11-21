//! `bank_accounts`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "bank_accounts")]
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
    #[serde(rename = "entityId")]
    pub entity_id: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "name")]
    pub name: String,
    #[sea_orm(column_type = "String(StringLen::N(34))")]
    #[serde(rename = "iban")]
    pub iban: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(11))")]
    #[serde(rename = "bic")]
    pub bic: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "bankName")]
    pub bank_name: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "accountHolderName")]
    pub account_holder_name: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(3))")]
    #[serde(rename = "currency")]
    pub currency: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "ledgerAccountId")]
    pub ledger_account_id: Option<String>,
    #[sea_orm(column_type = "Decimal(Some((18, 2)))")]
    #[serde(
        rename = "currentBalance",
        serialize_with = "crate::js::Numeric::<2>::serialize_option"
    )]
    pub current_balance: Option<BigDecimal>,
    #[serde(rename = "isDefault")]
    pub is_default: Option<bool>,
    #[serde(rename = "isActive")]
    pub is_active: Option<bool>,
    #[serde(rename = "lastImportDate", with = "crate::js::timestamp::option")]
    pub last_import_date: Option<TimeDateTime>,
    #[sea_orm(column_type = "Decimal(Some((18, 2)))")]
    #[serde(
        rename = "lastImportBalance",
        serialize_with = "crate::js::Numeric::<2>::serialize_option"
    )]
    pub last_import_balance: Option<BigDecimal>,
    #[serde(rename = "autoReconcile")]
    pub auto_reconcile: Option<bool>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "metadata")]
    pub metadata: Option<Json>,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "accountType")]
    pub account_type: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(9))")]
    #[serde(rename = "routingNumber")]
    pub routing_number: Option<String>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "accountNumberEncrypted")]
    pub account_number_encrypted: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(4))")]
    #[serde(rename = "accountNumberLast4")]
    pub account_number_last4: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "feedConnectionId")]
    pub feed_connection_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "feedProvider")]
    pub feed_provider: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "feedAccountId")]
    pub feed_account_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "feedAccountFingerprint")]
    pub feed_account_fingerprint: Option<String>,
    #[serde(rename = "feedSyncFrom", with = "crate::js::date::option")]
    pub feed_sync_from: Option<TimeDate>,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "feedStatus")]
    pub feed_status: Option<String>,
    #[serde(rename = "nextCheckNumber")]
    pub next_check_number: Option<i32>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "checkSettings")]
    pub check_settings: Option<Json>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "achSettings")]
    pub ach_settings: Option<Json>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "positivePayFormat")]
    pub positive_pay_format: Option<String>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "importSettings")]
    pub import_settings: Option<Json>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "bank_accounts",
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
            name: "currency",
            sql_type: None,
            default: Some(DdlDefault::Sql("'EUR'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "current_balance",
            sql_type: None,
            default: Some(DdlDefault::Sql("'0'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "is_default",
            sql_type: None,
            default: Some(DdlDefault::Bool(false)),
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
            name: "auto_reconcile",
            sql_type: None,
            default: Some(DdlDefault::Bool(true)),
            generated: None,
            default_fn: false,
            on_update: false,
        },
    ],
    primary_key: None,
    indexes: &[
        Index {
            name: "acct_bank_accounts_feed_connection_idx",
            columns: &[IndexColumn {
                expression: "feed_connection_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "acct_bank_accounts_entity_idx",
            columns: &[IndexColumn {
                expression: "entity_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "acct_bank_accounts_iban_idx",
            columns: &[IndexColumn {
                expression: "iban",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "acct_bank_accounts_is_active_idx",
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
