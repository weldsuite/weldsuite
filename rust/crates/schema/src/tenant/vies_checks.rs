//! `vies_checks`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "vies_checks")]
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
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "vatNumber")]
    pub vat_number: String,
    #[sea_orm(column_type = "String(StringLen::N(2))")]
    #[serde(rename = "countryCode")]
    pub country_code: String,
    #[serde(rename = "valid")]
    pub valid: bool,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "traderName")]
    pub trader_name: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(500))")]
    #[serde(rename = "traderAddress")]
    pub trader_address: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(50))")]
    #[serde(rename = "consultationNumber")]
    pub consultation_number: Option<String>,
    #[serde(rename = "checkedAt", with = "crate::js::timestamp")]
    pub checked_at: TimeDateTime,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "vies_checks",
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
    indexes: &[
        Index {
            name: "acct_vies_checks_country_idx",
            columns: &[IndexColumn {
                expression: "country_code",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "acct_vies_checks_checked_at_idx",
            columns: &[IndexColumn {
                expression: "checked_at",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
    ],
    foreign_keys: &[],
    uniques: &[Unique {
        name: "vies_checks_vat_number_unique",
        columns: &["vat_number"],
        nulls_not_distinct: false,
    }],
    checks: &[],
};
