//! `mail_dmarc_sources`: what a workspace said about a sending source in its
//! DMARC reports, "mine" or "not mine" (ADR MAIL-015). The key is
//! `weldsuite_mail_dmarc::sources::key`'s.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "mail_dmarc_sources")]
pub struct Model {
    #[sea_orm(
        primary_key,
        auto_increment = false,
        column_type = "String(StringLen::N(30))"
    )]
    #[serde(rename = "id")]
    pub id: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "mailDomainId")]
    pub mail_domain_id: String,
    /// `weldsuite:<pool>`, `name:<domain>` or `ip:<address>`.
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "sourceKey")]
    pub source_key: String,
    /// `mine` or `not_mine`.
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "mark")]
    pub mark: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "updatedBy")]
    pub updated_by: Option<String>,
    #[serde(rename = "createdAt", with = "crate::js::timestamptz")]
    pub created_at: TimeDateTimeWithTimeZone,
    #[serde(rename = "updatedAt", with = "crate::js::timestamptz")]
    pub updated_at: TimeDateTimeWithTimeZone,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "mail_dmarc_sources",
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
    indexes: &[],
    foreign_keys: &[],
    uniques: &[Unique {
        name: "mail_dmarc_sources_domain_key_unique",
        columns: &["mail_domain_id", "source_key"],
        nulls_not_distinct: false,
    }],
    checks: &[],
};
