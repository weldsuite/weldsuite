//! `mail_domains`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "mail_domains")]
pub struct Model {
    #[sea_orm(
        primary_key,
        auto_increment = false,
        column_type = "String(StringLen::N(30))"
    )]
    #[serde(rename = "id")]
    pub id: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "domainName")]
    pub domain_name: String,
    #[serde(rename = "isActive")]
    pub is_active: bool,
    #[serde(rename = "isPrimary")]
    pub is_primary: Option<bool>,
    #[sea_orm(column_type = "String(StringLen::N(100))")]
    #[serde(rename = "mailProvider")]
    pub mail_provider: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(50))")]
    #[serde(rename = "sendProvider")]
    pub send_provider: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(50))")]
    #[serde(rename = "receiveProvider")]
    pub receive_provider: Option<String>,
    #[serde(rename = "maxEmailAccounts")]
    pub max_email_accounts: Option<i32>,
    #[serde(rename = "currentEmailAccounts")]
    pub current_email_accounts: Option<i32>,
    #[serde(rename = "dnsStatus")]
    pub dns_status: Option<super::enums::MailDomainDnsStatus>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "dnsRecords")]
    pub dns_records: Option<Json>,
    #[serde(rename = "verifiedAt", with = "crate::js::timestamp::option")]
    pub verified_at: Option<TimeDateTime>,
    #[serde(
        rename = "lastVerificationAttempt",
        with = "crate::js::timestamp::option"
    )]
    pub last_verification_attempt: Option<TimeDateTime>,
    #[serde(rename = "spfVerified")]
    pub spf_verified: Option<bool>,
    #[serde(rename = "dkimVerified")]
    pub dkim_verified: Option<bool>,
    #[serde(rename = "dmarcVerified")]
    pub dmarc_verified: Option<bool>,
    #[sea_orm(column_type = "String(StringLen::N(100))")]
    #[serde(rename = "dkimSelector")]
    pub dkim_selector: Option<String>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "dkimPublicKey")]
    pub dkim_public_key: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "externalDomainId")]
    pub external_domain_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "mailcowDomainId")]
    pub mailcow_domain_id: Option<String>,
    #[serde(rename = "mailcowSyncedAt", with = "crate::js::timestamp::option")]
    pub mailcow_synced_at: Option<TimeDateTime>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "resendDomainId")]
    pub resend_domain_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(50))")]
    #[serde(rename = "resendStatus")]
    pub resend_status: Option<String>,
    #[serde(rename = "resendSyncedAt", with = "crate::js::timestamp::option")]
    pub resend_synced_at: Option<TimeDateTime>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "cloudflareZoneId")]
    pub cloudflare_zone_id: Option<String>,
    #[serde(rename = "cloudflareRoutingEnabled")]
    pub cloudflare_routing_enabled: Option<bool>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "cloudflareRoutingRuleId")]
    pub cloudflare_routing_rule_id: Option<String>,
    #[serde(rename = "catchAllEnabled")]
    pub catch_all_enabled: bool,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "catchAllAccountId")]
    pub catch_all_account_id: Option<String>,
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
    name: "mail_domains",
    columns: &[
        DdlColumn {
            name: "is_active",
            sql_type: None,
            default: Some(DdlDefault::Bool(false)),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "is_primary",
            sql_type: None,
            default: Some(DdlDefault::Bool(false)),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "mail_provider",
            sql_type: None,
            default: Some(DdlDefault::Sql("'cloudflare'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "send_provider",
            sql_type: None,
            default: Some(DdlDefault::Sql("'cloudflare'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "receive_provider",
            sql_type: None,
            default: Some(DdlDefault::Sql("'cloudflare'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "max_email_accounts",
            sql_type: None,
            default: Some(DdlDefault::Number("10")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "current_email_accounts",
            sql_type: None,
            default: Some(DdlDefault::Number("0")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "dns_status",
            sql_type: None,
            default: Some(DdlDefault::Sql("'pending'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "spf_verified",
            sql_type: None,
            default: Some(DdlDefault::Bool(false)),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "dkim_verified",
            sql_type: None,
            default: Some(DdlDefault::Bool(false)),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "dmarc_verified",
            sql_type: None,
            default: Some(DdlDefault::Bool(false)),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "cloudflare_routing_enabled",
            sql_type: None,
            default: Some(DdlDefault::Bool(false)),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "catch_all_enabled",
            sql_type: None,
            default: Some(DdlDefault::Bool(false)),
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
            name: "mail_domains_domain_name_idx",
            columns: &[IndexColumn {
                expression: "domain_name",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "mail_domains_is_active_idx",
            columns: &[IndexColumn {
                expression: "is_active",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "mail_domains_is_primary_idx",
            columns: &[IndexColumn {
                expression: "is_primary",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "mail_domains_external_domain_id_idx",
            columns: &[IndexColumn {
                expression: "external_domain_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "mail_domains_catch_all_account_id_idx",
            columns: &[IndexColumn {
                expression: "catch_all_account_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
    ],
    foreign_keys: &[ForeignKey {
        name: "mail_domains_catch_all_account_id_mail_accounts_id_fk",
        columns: &["catch_all_account_id"],
        references: "mail_accounts",
        referenced_columns: &["id"],
        on_delete: "no action",
        on_update: "no action",
    }],
    uniques: &[],
    checks: &[],
};
