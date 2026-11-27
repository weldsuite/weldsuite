//! `mail_dmarc_reports`: the DMARC aggregate reports received for one of the
//! workspace's verified mail domains (ADR MAIL-015). One row per reporter
//! and report id; its rows are in `mail_dmarc_records`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "mail_dmarc_reports")]
pub struct Model {
    #[sea_orm(
        primary_key,
        auto_increment = false,
        column_type = "String(StringLen::N(30))"
    )]
    #[serde(rename = "id")]
    pub id: String,
    /// The verified `mail_domains` row the report is about.
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "mailDomainId")]
    pub mail_domain_id: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "domainName")]
    pub domain_name: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "reporterOrg")]
    pub reporter_org: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "reporterEmail")]
    pub reporter_email: String,
    /// The reporter's address's domain, lower-cased (`google.com`).
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "reporterDomain")]
    pub reporter_domain: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "reportId")]
    pub report_id: String,
    #[serde(rename = "periodStart", with = "crate::js::timestamptz")]
    pub period_start: TimeDateTimeWithTimeZone,
    #[serde(rename = "periodEnd", with = "crate::js::timestamptz")]
    pub period_end: TimeDateTimeWithTimeZone,
    /// The domain whose `_dmarc` record the reporter found.
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "policyDomain")]
    pub policy_domain: String,
    /// `policy_published` as the reporter saw it.
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "policy")]
    pub policy: Option<Json>,
    /// The report's own message passed DMARC for the reporter's domain.
    #[serde(rename = "authenticated")]
    pub authenticated: bool,
    /// Messages in this domain's rows, and how many passed DMARC.
    #[serde(rename = "messages")]
    pub messages: i32,
    #[serde(rename = "passed")]
    pub passed: i32,
    #[serde(rename = "receivedAt", with = "crate::js::timestamptz")]
    pub received_at: TimeDateTimeWithTimeZone,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "mail_dmarc_reports",
    columns: &[
        DdlColumn {
            name: "authenticated",
            sql_type: None,
            default: Some(DdlDefault::Bool(false)),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "messages",
            sql_type: None,
            default: Some(DdlDefault::Number("0")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "passed",
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
        name: "mail_dmarc_reports_domain_period_idx",
        columns: &[
            IndexColumn {
                expression: "mail_domain_id",
                is_expression: false,
                asc: true,
            },
            IndexColumn {
                expression: "period_end",
                is_expression: false,
                asc: true,
            },
        ],
        unique: false,
        method: "btree",
        filter: None,
    }],
    foreign_keys: &[],
    uniques: &[Unique {
        name: "mail_dmarc_reports_report_unique",
        columns: &["mail_domain_id", "reporter_domain", "report_id"],
        nulls_not_distinct: false,
    }],
    checks: &[],
};
