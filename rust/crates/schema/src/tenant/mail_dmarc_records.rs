//! `mail_dmarc_records`: the rows of a `mail_dmarc_reports` report: the
//! messages one source IP sent as the domain, and how they fared (ADR
//! MAIL-015).

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "mail_dmarc_records")]
pub struct Model {
    #[sea_orm(
        primary_key,
        auto_increment = false,
        column_type = "String(StringLen::N(30))"
    )]
    #[serde(rename = "id")]
    pub id: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "reportId")]
    pub report_id: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "mailDomainId")]
    pub mail_domain_id: String,
    /// The report's period end, for the window queries.
    #[serde(rename = "periodEnd", with = "crate::js::timestamptz")]
    pub period_end: TimeDateTimeWithTimeZone,
    #[sea_orm(column_type = "String(StringLen::N(45))")]
    #[serde(rename = "sourceIp")]
    pub source_ip: String,
    /// The source IP's reverse DNS name, when it has one.
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "sourceName")]
    pub source_name: Option<String>,
    /// WeldSuite's own sending pool, when the IP is one of the MTA's.
    #[sea_orm(column_type = "String(StringLen::N(50))")]
    #[serde(rename = "weldsuitePool")]
    pub weldsuite_pool: Option<String>,
    /// The sending source (`weldsuite_mail_dmarc::sources::key`), so the
    /// summary groups in SQL.
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "sourceKey")]
    pub source_key: String,
    #[serde(rename = "count")]
    pub count: i32,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "disposition")]
    pub disposition: String,
    #[serde(rename = "dkimAligned")]
    pub dkim_aligned: bool,
    #[serde(rename = "spfAligned")]
    pub spf_aligned: bool,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "headerFrom")]
    pub header_from: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "envelopeFrom")]
    pub envelope_from: Option<String>,
    /// `[{ domain, selector, result }]`.
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "dkimResults")]
    pub dkim_results: Option<Json>,
    /// `[{ domain, scope, result }]`.
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "spfResults")]
    pub spf_results: Option<Json>,
    /// `[{ type, comment }]`: why the disposition differs from the policy.
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "reasons")]
    pub reasons: Option<Json>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "mail_dmarc_records",
    columns: &[],
    primary_key: None,
    indexes: &[
        Index {
            name: "mail_dmarc_records_domain_period_idx",
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
        },
        Index {
            name: "mail_dmarc_records_report_idx",
            columns: &[IndexColumn {
                expression: "report_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
    ],
    foreign_keys: &[ForeignKey {
        name: "mail_dmarc_records_report_id_mail_dmarc_reports_id_fk",
        columns: &["report_id"],
        references: "mail_dmarc_reports",
        referenced_columns: &["id"],
        on_delete: "cascade",
        on_update: "no action",
    }],
    uniques: &[],
    checks: &[],
};
