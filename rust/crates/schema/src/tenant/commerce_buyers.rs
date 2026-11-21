//! `commerce_buyers`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "commerce_buyers")]
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
    #[serde(rename = "personId")]
    pub person_id: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "companyId")]
    pub company_id: String,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "role")]
    pub role: String,
    #[sea_orm(column_type = "Decimal(Some((18, 2)))")]
    #[serde(
        rename = "spendLimit",
        serialize_with = "crate::js::Numeric::<2>::serialize_option"
    )]
    pub spend_limit: Option<BigDecimal>,
    #[sea_orm(column_type = "String(StringLen::N(3))")]
    #[serde(rename = "spendLimitCurrency")]
    pub spend_limit_currency: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "status")]
    pub status: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "invitedBy")]
    pub invited_by: Option<String>,
    #[serde(rename = "invitedAt", with = "crate::js::timestamp::option")]
    pub invited_at: Option<TimeDateTime>,
    #[serde(rename = "acceptedAt", with = "crate::js::timestamp::option")]
    pub accepted_at: Option<TimeDateTime>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "commerce_buyers",
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
            name: "role",
            sql_type: None,
            default: Some(DdlDefault::Sql("'buyer'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "status",
            sql_type: None,
            default: Some(DdlDefault::Sql("'invited'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
    ],
    primary_key: None,
    indexes: &[
        Index {
            name: "commerce_buyers_person_company_uidx",
            columns: &[
                IndexColumn {
                    expression: "person_id",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "company_id",
                    is_expression: false,
                    asc: true,
                },
            ],
            unique: true,
            method: "btree",
            filter: Some("\"commerce_buyers\".\"deleted_at\" IS NULL"),
        },
        Index {
            name: "commerce_buyers_company_idx",
            columns: &[
                IndexColumn {
                    expression: "company_id",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "status",
                    is_expression: false,
                    asc: true,
                },
            ],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "commerce_buyers_person_idx",
            columns: &[IndexColumn {
                expression: "person_id",
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
