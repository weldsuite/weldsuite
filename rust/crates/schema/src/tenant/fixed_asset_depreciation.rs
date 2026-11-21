//! `fixed_asset_depreciation`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "fixed_asset_depreciation")]
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
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "entityId")]
    pub entity_id: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "assetId")]
    pub asset_id: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "bookId")]
    pub book_id: String,
    #[serde(rename = "periodStart", with = "crate::js::date")]
    pub period_start: TimeDate,
    #[serde(rename = "periodEnd", with = "crate::js::date")]
    pub period_end: TimeDate,
    #[sea_orm(column_type = "Decimal(Some((18, 2)))")]
    #[serde(
        rename = "amount",
        serialize_with = "crate::js::Numeric::<2>::serialize"
    )]
    pub amount: BigDecimal,
    #[sea_orm(column_type = "Decimal(Some((18, 2)))")]
    #[serde(
        rename = "accumulated",
        serialize_with = "crate::js::Numeric::<2>::serialize"
    )]
    pub accumulated: BigDecimal,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "journalEntryId")]
    pub journal_entry_id: Option<String>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "fixed_asset_depreciation",
    columns: &[DdlColumn {
        name: "created_at",
        sql_type: None,
        default: Some(DdlDefault::Sql("now()")),
        generated: None,
        default_fn: false,
        on_update: false,
    }],
    primary_key: None,
    indexes: &[
        Index {
            name: "acct_fixed_asset_dep_asset_idx",
            columns: &[
                IndexColumn {
                    expression: "asset_id",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "period_start",
                    is_expression: false,
                    asc: true,
                },
            ],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "acct_fixed_asset_dep_book_idx",
            columns: &[IndexColumn {
                expression: "book_id",
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
