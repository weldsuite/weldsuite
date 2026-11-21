//! `email_forwards`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "email_forwards")]
pub struct Model {
    #[sea_orm(
        primary_key,
        auto_increment = false,
        column_type = "String(StringLen::N(30))"
    )]
    #[serde(rename = "id")]
    pub id: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "domainId")]
    pub domain_id: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "source")]
    pub source: String,
    #[sea_orm(column_type = "String(StringLen::N(500))")]
    #[serde(rename = "destination")]
    pub destination: String,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "additionalDestinations")]
    pub additional_destinations: Option<Json>,
    #[serde(rename = "enabled")]
    pub enabled: bool,
    #[serde(rename = "catchAll")]
    pub catch_all: Option<bool>,
    #[serde(rename = "wildcard")]
    pub wildcard: Option<bool>,
    #[serde(rename = "status")]
    pub status: super::enums::HostEmailForwardStatus,
    #[serde(rename = "lastForwardedAt", with = "crate::js::timestamp::option")]
    pub last_forwarded_at: Option<TimeDateTime>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "forwardCount")]
    pub forward_count: Option<Json>,
    #[sea_orm(column_type = "String(StringLen::N(1000))")]
    #[serde(rename = "lastError")]
    pub last_error: Option<String>,
    #[serde(rename = "lastErrorAt", with = "crate::js::timestamp::option")]
    pub last_error_at: Option<TimeDateTime>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "errorCount")]
    pub error_count: Option<Json>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "metadata")]
    pub metadata: Option<Json>,
    #[serde(rename = "createdAt", with = "crate::js::timestamp")]
    pub created_at: TimeDateTime,
    #[serde(rename = "updatedAt", with = "crate::js::timestamp")]
    pub updated_at: TimeDateTime,
    #[serde(rename = "deletedAt", with = "crate::js::timestamp::option")]
    pub deleted_at: Option<TimeDateTime>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "email_forwards",
    columns: &[
        DdlColumn {
            name: "enabled",
            sql_type: None,
            default: Some(DdlDefault::Bool(true)),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "catch_all",
            sql_type: None,
            default: Some(DdlDefault::Bool(false)),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "wildcard",
            sql_type: None,
            default: Some(DdlDefault::Bool(false)),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "status",
            sql_type: None,
            default: Some(DdlDefault::Sql("'active'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "forward_count",
            sql_type: None,
            default: Some(DdlDefault::Sql("'0'::jsonb")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "error_count",
            sql_type: None,
            default: Some(DdlDefault::Sql("'0'::jsonb")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
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
            name: "email_forwards_domain_id_idx",
            columns: &[IndexColumn {
                expression: "domain_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "email_forwards_source_idx",
            columns: &[IndexColumn {
                expression: "source",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "email_forwards_enabled_idx",
            columns: &[IndexColumn {
                expression: "enabled",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
    ],
    foreign_keys: &[ForeignKey {
        name: "email_forwards_domain_id_domains_id_fk",
        columns: &["domain_id"],
        references: "domains",
        referenced_columns: &["id"],
        on_delete: "no action",
        on_update: "no action",
    }],
    uniques: &[],
    checks: &[],
};
