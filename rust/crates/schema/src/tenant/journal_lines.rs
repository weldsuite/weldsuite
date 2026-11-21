//! `journal_lines`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "journal_lines")]
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
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "journalEntryId")]
    pub journal_entry_id: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "accountId")]
    pub account_id: String,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "description")]
    pub description: Option<String>,
    #[sea_orm(column_type = "Decimal(Some((18, 2)))")]
    #[serde(
        rename = "debit",
        serialize_with = "crate::js::Numeric::<2>::serialize_option"
    )]
    pub debit: Option<BigDecimal>,
    #[sea_orm(column_type = "Decimal(Some((18, 2)))")]
    #[serde(
        rename = "credit",
        serialize_with = "crate::js::Numeric::<2>::serialize_option"
    )]
    pub credit: Option<BigDecimal>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "taxRateId")]
    pub tax_rate_id: Option<String>,
    #[sea_orm(column_type = "Decimal(Some((18, 2)))")]
    #[serde(
        rename = "taxAmount",
        serialize_with = "crate::js::Numeric::<2>::serialize_option"
    )]
    pub tax_amount: Option<BigDecimal>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "contactId")]
    pub contact_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(3))")]
    #[serde(rename = "currency")]
    pub currency: Option<String>,
    #[sea_orm(column_type = "Decimal(Some((12, 6)))")]
    #[serde(
        rename = "exchangeRate",
        serialize_with = "crate::js::Numeric::<6>::serialize_option"
    )]
    pub exchange_rate: Option<BigDecimal>,
    #[sea_orm(column_type = "Decimal(Some((18, 2)))")]
    #[serde(
        rename = "baseCurrencyDebit",
        serialize_with = "crate::js::Numeric::<2>::serialize_option"
    )]
    pub base_currency_debit: Option<BigDecimal>,
    #[sea_orm(column_type = "Decimal(Some((18, 2)))")]
    #[serde(
        rename = "baseCurrencyCredit",
        serialize_with = "crate::js::Numeric::<2>::serialize_option"
    )]
    pub base_currency_credit: Option<BigDecimal>,
    #[serde(rename = "reconciled")]
    pub reconciled: Option<bool>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "reconciliationId")]
    pub reconciliation_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "classId")]
    pub class_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "locationId")]
    pub location_id: Option<String>,
    #[serde(rename = "sortOrder")]
    pub sort_order: Option<i32>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "projectId")]
    pub project_id: Option<String>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "journal_lines",
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
            name: "debit",
            sql_type: None,
            default: Some(DdlDefault::Sql("'0'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "credit",
            sql_type: None,
            default: Some(DdlDefault::Sql("'0'")),
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
            name: "exchange_rate",
            sql_type: None,
            default: Some(DdlDefault::Sql("'1'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "reconciled",
            sql_type: None,
            default: Some(DdlDefault::Bool(false)),
            generated: None,
            default_fn: false,
            on_update: false,
        },
    ],
    primary_key: None,
    indexes: &[
        Index {
            name: "acct_journal_lines_project_idx",
            columns: &[IndexColumn {
                expression: "project_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "acct_journal_lines_reconciliation_idx",
            columns: &[IndexColumn {
                expression: "reconciliation_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "acct_journal_lines_entity_idx",
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
            name: "acct_journal_lines_entry_idx",
            columns: &[IndexColumn {
                expression: "journal_entry_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "acct_journal_lines_account_idx",
            columns: &[IndexColumn {
                expression: "account_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "acct_journal_lines_contact_idx",
            columns: &[IndexColumn {
                expression: "contact_id",
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
