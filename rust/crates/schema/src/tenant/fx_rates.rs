//! `fx_rates`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "fx_rates")]
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
    #[serde(rename = "date", with = "crate::js::date")]
    pub date: TimeDate,
    #[sea_orm(column_type = "String(StringLen::N(3))")]
    #[serde(rename = "fromCurrency")]
    pub from_currency: String,
    #[sea_orm(column_type = "String(StringLen::N(3))")]
    #[serde(rename = "toCurrency")]
    pub to_currency: String,
    #[sea_orm(column_type = "Decimal(Some((18, 8)))")]
    #[serde(rename = "rate", serialize_with = "crate::js::Numeric::<8>::serialize")]
    pub rate: BigDecimal,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "source")]
    pub source: String,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "fx_rates",
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
            name: "source",
            sql_type: None,
            default: Some(DdlDefault::Sql("'ecb'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
    ],
    primary_key: None,
    indexes: &[
        Index {
            name: "fx_rates_unique",
            columns: &[
                IndexColumn {
                    expression: "date",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "from_currency",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "to_currency",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "source",
                    is_expression: false,
                    asc: true,
                },
            ],
            unique: true,
            method: "btree",
            filter: None,
        },
        Index {
            name: "fx_rates_date_idx",
            columns: &[IndexColumn {
                expression: "date",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "fx_rates_pair_idx",
            columns: &[
                IndexColumn {
                    expression: "from_currency",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "to_currency",
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
