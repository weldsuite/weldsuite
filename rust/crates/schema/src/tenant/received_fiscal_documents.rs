//! `received_fiscal_documents`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "received_fiscal_documents")]
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
    #[sea_orm(column_type = "String(StringLen::N(10))")]
    #[serde(rename = "kind")]
    pub kind: String,
    #[sea_orm(column_type = "String(StringLen::N(44))")]
    #[serde(rename = "accessKey")]
    pub access_key: String,
    #[sea_orm(column_type = "String(StringLen::N(14))")]
    #[serde(rename = "issuerTaxId")]
    pub issuer_tax_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "issuerName")]
    pub issuer_name: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "number")]
    pub number: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(5))")]
    #[serde(rename = "series")]
    pub series: Option<String>,
    #[serde(rename = "issueDate", with = "crate::js::date::option")]
    pub issue_date: Option<TimeDate>,
    #[sea_orm(column_type = "Decimal(Some((18, 2)))")]
    #[serde(
        rename = "total",
        serialize_with = "crate::js::Numeric::<2>::serialize_option"
    )]
    pub total: Option<BigDecimal>,
    #[sea_orm(column_type = "String(StringLen::N(15))")]
    #[serde(rename = "status")]
    pub status: String,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "manifestation")]
    pub manifestation: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "source")]
    pub source: String,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "xml")]
    pub xml: Option<String>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "parsed")]
    pub parsed: Option<Json>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "billId")]
    pub bill_id: Option<String>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "received_fiscal_documents",
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
            name: "kind",
            sql_type: None,
            default: Some(DdlDefault::Sql("'nfe'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "status",
            sql_type: None,
            default: Some(DdlDefault::Sql("'new'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
    ],
    primary_key: None,
    indexes: &[
        Index {
            name: "received_fiscal_documents_key_idx",
            columns: &[
                IndexColumn {
                    expression: "entity_id",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "access_key",
                    is_expression: false,
                    asc: true,
                },
            ],
            unique: true,
            method: "btree",
            filter: None,
        },
        Index {
            name: "received_fiscal_documents_status_idx",
            columns: &[
                IndexColumn {
                    expression: "entity_id",
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
    ],
    foreign_keys: &[],
    uniques: &[],
    checks: &[],
};
