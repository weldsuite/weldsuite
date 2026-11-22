//! `mail_threat_indicators`: known-bad links for WeldMail's link checks,
//! synced from public threat feeds by `weldsuite cron mail-threat-feeds`
//! (`crates/mail-inbound`'s `threats`). Master, because the feeds are the
//! same for every workspace and a lookup must never open a tenant.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "mail_threat_indicators")]
pub struct Model {
    /// `url` (one exact, normalised link) or `host` (a domain and its
    /// subdomains).
    #[sea_orm(
        primary_key,
        auto_increment = false,
        column_type = "String(StringLen::N(10))"
    )]
    #[serde(rename = "kind")]
    pub kind: String,
    /// The normalised link or the lower-case host.
    #[sea_orm(
        primary_key,
        auto_increment = false,
        column_type = "String(StringLen::N(2048))"
    )]
    #[serde(rename = "value")]
    pub value: String,
    /// The feed's name from `MAIL_THREAT_FEEDS`.
    #[sea_orm(column_type = "String(StringLen::N(50))")]
    #[serde(rename = "source")]
    pub source: String,
    /// `malware` or `phishing`.
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "threat")]
    pub threat: String,
    #[serde(rename = "firstSeenAt", with = "crate::js::timestamptz")]
    pub first_seen_at: TimeDateTimeWithTimeZone,
    /// The last sync that still listed it; older ones are pruned.
    #[serde(rename = "lastSeenAt", with = "crate::js::timestamptz")]
    pub last_seen_at: TimeDateTimeWithTimeZone,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "mail_threat_indicators",
    columns: &[
        DdlColumn {
            name: "first_seen_at",
            sql_type: None,
            default: Some(DdlDefault::Sql("now()")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "last_seen_at",
            sql_type: None,
            default: Some(DdlDefault::Sql("now()")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
    ],
    primary_key: Some(DdlPrimaryKey {
        name: "mail_threat_indicators_kind_value_pk",
        columns: &["kind", "value"],
    }),
    indexes: &[Index {
        name: "mail_threat_indicators_source_seen_idx",
        columns: &[
            IndexColumn {
                expression: "source",
                is_expression: false,
                asc: true,
            },
            IndexColumn {
                expression: "last_seen_at",
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
