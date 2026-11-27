//! `mail_dmarc_pool_daily`: the operator's view of WeldSuite's own sending
//! addresses in DMARC aggregate reports, per day, pool, address, reporter
//! and From domain (ADR MAIL-015). Only rows whose source is one of the
//! MTA's addresses; kept 400 days.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "mail_dmarc_pool_daily")]
pub struct Model {
    #[sea_orm(
        primary_key,
        auto_increment = false,
        column_type = "String(StringLen::N(30))"
    )]
    #[serde(rename = "id")]
    pub id: String,
    /// The UTC day the report's period ends on.
    #[serde(rename = "day", with = "crate::js::date")]
    pub day: TimeDate,
    #[sea_orm(column_type = "String(StringLen::N(50))")]
    #[serde(rename = "pool")]
    pub pool: String,
    #[sea_orm(column_type = "String(StringLen::N(45))")]
    #[serde(rename = "sourceIp")]
    pub source_ip: String,
    /// The reporter's domain (`google.com`).
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "reporter")]
    pub reporter: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "headerFromDomain")]
    pub header_from_domain: String,
    #[serde(rename = "messages")]
    pub messages: i32,
    #[serde(rename = "dkimAligned")]
    pub dkim_aligned: i32,
    #[serde(rename = "spfAligned")]
    pub spf_aligned: i32,
    #[serde(rename = "dmarcPass")]
    pub dmarc_pass: i32,
    #[serde(rename = "dispositionQuarantine")]
    pub disposition_quarantine: i32,
    #[serde(rename = "dispositionReject")]
    pub disposition_reject: i32,
    #[serde(rename = "updatedAt", with = "crate::js::timestamptz")]
    pub updated_at: TimeDateTimeWithTimeZone,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

const fn zero(name: &'static str) -> DdlColumn {
    DdlColumn {
        name,
        sql_type: None,
        default: Some(DdlDefault::Number("0")),
        generated: None,
        default_fn: false,
        on_update: false,
    }
}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "mail_dmarc_pool_daily",
    columns: &[
        zero("messages"),
        zero("dkim_aligned"),
        zero("spf_aligned"),
        zero("dmarc_pass"),
        zero("disposition_quarantine"),
        zero("disposition_reject"),
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
    indexes: &[Index {
        name: "mail_dmarc_pool_daily_day_idx",
        columns: &[IndexColumn {
            expression: "day",
            is_expression: false,
            asc: true,
        }],
        unique: false,
        method: "btree",
        filter: None,
    }],
    foreign_keys: &[],
    uniques: &[Unique {
        name: "mail_dmarc_pool_daily_row_unique",
        columns: &["day", "pool", "source_ip", "reporter", "header_from_domain"],
        nulls_not_distinct: false,
    }],
    checks: &[],
};
