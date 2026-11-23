//! `carriers`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "carriers")]
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
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "name")]
    pub name: String,
    #[sea_orm(column_type = "String(StringLen::N(50))")]
    #[serde(rename = "code")]
    pub code: String,
    #[sea_orm(column_type = "String(StringLen::N(500))")]
    #[serde(rename = "logo")]
    pub logo: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(500))")]
    #[serde(rename = "website")]
    pub website: Option<String>,
    #[serde(rename = "isActive")]
    pub is_active: Option<bool>,
    #[serde(rename = "isDefault")]
    pub is_default: Option<bool>,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "integrationType")]
    pub integration_type: String,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "apiCredentials")]
    pub api_credentials: Option<Json>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "supportedServices")]
    pub supported_services: Option<Json>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "supportedCountries")]
    pub supported_countries: Option<Json>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "features")]
    pub features: Option<Json>,
    #[sea_orm(column_type = "String(StringLen::N(500))")]
    #[serde(rename = "trackingUrlTemplate")]
    pub tracking_url_template: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "supportEmail")]
    pub support_email: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(50))")]
    #[serde(rename = "supportPhone")]
    pub support_phone: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(100))")]
    #[serde(rename = "accountNumber")]
    pub account_number: Option<String>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "settings")]
    pub settings: Option<Json>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "description")]
    pub description: Option<String>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "carriers",
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
        DdlColumn {
            name: "is_default",
            sql_type: None,
            default: Some(DdlDefault::Bool(false)),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "integration_type",
            sql_type: None,
            default: Some(DdlDefault::Sql("'manual'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
    ],
    primary_key: None,
    indexes: &[
        Index {
            name: "carriers_code_idx",
            columns: &[IndexColumn {
                expression: "code",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "carriers_is_active_idx",
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
