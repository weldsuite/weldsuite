//! `tax_rates`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "tax_rates")]
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
    #[sea_orm(column_type = "String(StringLen::N(5))")]
    #[serde(rename = "jurisdictionCode")]
    pub jurisdiction_code: String,
    #[sea_orm(column_type = "String(StringLen::N(100))")]
    #[serde(rename = "name")]
    pub name: String,
    #[sea_orm(column_type = "Decimal(Some((7, 4)))")]
    #[serde(rename = "rate", serialize_with = "crate::js::Numeric::<4>::serialize")]
    pub rate: BigDecimal,
    #[sea_orm(column_name = "type", column_type = "String(StringLen::N(10))")]
    #[serde(rename = "type")]
    pub type_: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "taxCategoryCode")]
    pub tax_category_code: Option<String>,
    #[serde(rename = "isDefault")]
    pub is_default: Option<bool>,
    #[serde(rename = "isActive")]
    pub is_active: Option<bool>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "description")]
    pub description: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "ledgerAccountId")]
    pub ledger_account_id: Option<String>,
    #[serde(rename = "effectiveFrom", with = "crate::js::date::option")]
    pub effective_from: Option<TimeDate>,
    #[serde(rename = "effectiveTo", with = "crate::js::date::option")]
    pub effective_to: Option<TimeDate>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "jurisdictionMetadata")]
    pub jurisdiction_metadata: Option<Json>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "tax_rates",
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
    ],
    primary_key: None,
    indexes: &[
        Index {
            name: "acct_tax_rates_entity_idx",
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
            name: "acct_tax_rates_jurisdiction_idx",
            columns: &[IndexColumn {
                expression: "jurisdiction_code",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "acct_tax_rates_type_idx",
            columns: &[IndexColumn {
                expression: "type",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "acct_tax_rates_category_idx",
            columns: &[IndexColumn {
                expression: "tax_category_code",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "acct_tax_rates_is_active_idx",
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
