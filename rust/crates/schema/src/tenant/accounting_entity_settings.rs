//! `accounting_entity_settings`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "accounting_entity_settings")]
pub struct Model {
    #[sea_orm(
        primary_key,
        auto_increment = false,
        column_type = "String(StringLen::N(30))"
    )]
    #[serde(rename = "entityId")]
    pub entity_id: String,
    #[serde(rename = "salesLockDate", with = "crate::js::date::option")]
    pub sales_lock_date: Option<TimeDate>,
    #[serde(rename = "purchaseLockDate", with = "crate::js::date::option")]
    pub purchase_lock_date: Option<TimeDate>,
    #[serde(rename = "taxLockDate", with = "crate::js::date::option")]
    pub tax_lock_date: Option<TimeDate>,
    #[serde(rename = "periodLockDate", with = "crate::js::date::option")]
    pub period_lock_date: Option<TimeDate>,
    #[serde(rename = "hardLockDate", with = "crate::js::date::option")]
    pub hard_lock_date: Option<TimeDate>,
    #[sea_orm(column_type = "String(StringLen::N(10))")]
    #[serde(rename = "accountingMethod")]
    pub accounting_method: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "salesTaxEngine")]
    pub sales_tax_engine: Option<String>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "salesTaxEngineConfig")]
    pub sales_tax_engine_config: Option<Json>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "salesTaxCredentialsEncrypted")]
    pub sales_tax_credentials_encrypted: Option<String>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "fiscalCredentialsEncrypted")]
    pub fiscal_credentials_encrypted: Option<String>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "ssnEncrypted")]
    pub ssn_encrypted: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(4))")]
    #[serde(rename = "ssnLast4")]
    pub ssn_last4: Option<String>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "jurisdictionSettings")]
    pub jurisdiction_settings: Option<Json>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "invoiceBankAccountId")]
    pub invoice_bank_account_id: Option<String>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "documentTexts")]
    pub document_texts: Option<Json>,
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
    name: "accounting_entity_settings",
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
    ],
    primary_key: None,
    indexes: &[],
    foreign_keys: &[],
    uniques: &[],
    checks: &[],
};
