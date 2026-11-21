//! `accounting_dimension_values`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "accounting_dimension_values")]
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
    #[sea_orm(column_type = "String(StringLen::N(10))")]
    #[serde(rename = "dimension")]
    pub dimension: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "code")]
    pub code: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "name")]
    pub name: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "parentId")]
    pub parent_id: Option<String>,
    #[serde(rename = "isActive")]
    pub is_active: bool,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "accounting_dimension_values",
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
            name: "is_active",
            sql_type: None,
            default: Some(DdlDefault::Bool(true)),
            generated: None,
            default_fn: false,
            on_update: false,
        },
    ],
    primary_key: None,
    indexes: &[Index {
        name: "acct_dimension_values_entity_idx",
        columns: &[
            IndexColumn {
                expression: "entity_id",
                is_expression: false,
                asc: true,
            },
            IndexColumn {
                expression: "dimension",
                is_expression: false,
                asc: true,
            },
        ],
        unique: false,
        method: "btree",
        filter: None,
    }],
    foreign_keys: &[],
    uniques: &[],
    checks: &[],
};
