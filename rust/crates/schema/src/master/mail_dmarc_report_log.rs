//! `mail_dmarc_report_log`: every DMARC aggregate report the install
//! received, once (ADR MAIL-015). Its unique key makes a resent or
//! redelivered report count once in the operator's rollup and alerts. Holds
//! no customer rows: who reported, which report, which policy domain, and
//! what became of it.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "mail_dmarc_report_log")]
pub struct Model {
    #[sea_orm(
        primary_key,
        auto_increment = false,
        column_type = "String(StringLen::N(30))"
    )]
    #[serde(rename = "id")]
    pub id: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "reporterDomain")]
    pub reporter_domain: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "reportId")]
    pub report_id: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "policyDomain")]
    pub policy_domain: String,
    #[serde(rename = "messages")]
    pub messages: i32,
    /// `stored` (in at least one workspace), `operator` (WeldSuite's own
    /// domain only) or `unknown_domain`.
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "outcome")]
    pub outcome: String,
    #[serde(rename = "receivedAt", with = "crate::js::timestamptz")]
    pub received_at: TimeDateTimeWithTimeZone,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "mail_dmarc_report_log",
    columns: &[
        DdlColumn {
            name: "messages",
            sql_type: None,
            default: Some(DdlDefault::Number("0")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "received_at",
            sql_type: None,
            default: Some(DdlDefault::Sql("now()")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
    ],
    primary_key: None,
    indexes: &[Index {
        name: "mail_dmarc_report_log_received_at_idx",
        columns: &[IndexColumn {
            expression: "received_at",
            is_expression: false,
            asc: true,
        }],
        unique: false,
        method: "btree",
        filter: None,
    }],
    foreign_keys: &[],
    uniques: &[Unique {
        name: "mail_dmarc_report_log_report_unique",
        columns: &["reporter_domain", "report_id", "policy_domain"],
        nulls_not_distinct: false,
    }],
    checks: &[],
};
