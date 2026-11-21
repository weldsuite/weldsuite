//! `bank_reconciliations`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "bank_reconciliations")]
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
    #[serde(rename = "entityId")]
    pub entity_id: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "bankAccountId")]
    pub bank_account_id: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "ledgerAccountId")]
    pub ledger_account_id: String,
    #[serde(rename = "statementDate", with = "crate::js::date")]
    pub statement_date: TimeDate,
    #[sea_orm(column_type = "Decimal(Some((18, 2)))")]
    #[serde(
        rename = "beginningBalance",
        serialize_with = "crate::js::Numeric::<2>::serialize"
    )]
    pub beginning_balance: BigDecimal,
    #[sea_orm(column_type = "Decimal(Some((18, 2)))")]
    #[serde(
        rename = "statementEndingBalance",
        serialize_with = "crate::js::Numeric::<2>::serialize"
    )]
    pub statement_ending_balance: BigDecimal,
    #[sea_orm(column_type = "Decimal(Some((18, 2)))")]
    #[serde(
        rename = "clearedBalance",
        serialize_with = "crate::js::Numeric::<2>::serialize_option"
    )]
    pub cleared_balance: Option<BigDecimal>,
    #[sea_orm(column_type = "Decimal(Some((18, 2)))")]
    #[serde(
        rename = "difference",
        serialize_with = "crate::js::Numeric::<2>::serialize_option"
    )]
    pub difference: Option<BigDecimal>,
    #[sea_orm(column_type = "String(StringLen::N(15))")]
    #[serde(rename = "status")]
    pub status: String,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "clearedLineIds")]
    pub cleared_line_ids: Option<Json>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "report")]
    pub report: Option<Json>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "adjustmentJournalEntryId")]
    pub adjustment_journal_entry_id: Option<String>,
    #[serde(rename = "completedAt", with = "crate::js::timestamp::option")]
    pub completed_at: Option<TimeDateTime>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "completedBy")]
    pub completed_by: Option<String>,
    #[serde(rename = "undoneAt", with = "crate::js::timestamp::option")]
    pub undone_at: Option<TimeDateTime>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "undoneBy")]
    pub undone_by: Option<String>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "bank_reconciliations",
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
            name: "status",
            sql_type: None,
            default: Some(DdlDefault::Sql("'in_progress'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
    ],
    primary_key: None,
    indexes: &[
        Index {
            name: "acct_bank_recs_entity_idx",
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
            name: "acct_bank_recs_bank_account_idx",
            columns: &[
                IndexColumn {
                    expression: "bank_account_id",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "statement_date",
                    is_expression: false,
                    asc: true,
                },
            ],
            unique: false,
            method: "btree",
            filter: None,
        },
    ],
    foreign_keys: &[],
    uniques: &[],
    checks: &[],
};
