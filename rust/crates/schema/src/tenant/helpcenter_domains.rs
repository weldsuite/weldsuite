//! `helpcenter_domains`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "helpcenter_domains")]
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
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "helpcenterSettingsId")]
    pub helpcenter_settings_id: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "domain")]
    pub domain: String,
    #[sea_orm(column_type = "String(StringLen::N(100))")]
    #[serde(rename = "subdomain")]
    pub subdomain: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "rootDomain")]
    pub root_domain: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "domainType")]
    pub domain_type: Option<String>,
    #[serde(rename = "isPrimary")]
    pub is_primary: Option<i32>,
    #[serde(rename = "isVerified")]
    pub is_verified: Option<i32>,
    #[serde(rename = "isActive")]
    pub is_active: Option<i32>,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "verificationMethod")]
    pub verification_method: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "verificationToken")]
    pub verification_token: Option<String>,
    #[serde(rename = "verifiedAt", with = "crate::js::timestamp::option")]
    pub verified_at: Option<TimeDateTime>,
    #[serde(
        rename = "lastVerificationAttempt",
        with = "crate::js::timestamp::option"
    )]
    pub last_verification_attempt: Option<TimeDateTime>,
    #[sea_orm(column_type = "String(StringLen::N(500))")]
    #[serde(rename = "verificationError")]
    pub verification_error: Option<String>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "dnsConfig")]
    pub dns_config: Option<Json>,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "dnsStatus")]
    pub dns_status: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "sslStatus")]
    pub ssl_status: Option<String>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "helpcenter_domains",
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
            name: "domain_type",
            sql_type: None,
            default: Some(DdlDefault::Sql("'custom'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "is_primary",
            sql_type: None,
            default: Some(DdlDefault::Number("0")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "is_verified",
            sql_type: None,
            default: Some(DdlDefault::Number("0")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "is_active",
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
            name: "ssl_status",
            sql_type: None,
            default: Some(DdlDefault::Sql("'pending'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
    ],
    primary_key: None,
    indexes: &[
        Index {
            name: "helpcenter_domains_settings_idx",
            columns: &[IndexColumn {
                expression: "helpcenter_settings_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "helpcenter_domains_domain_idx",
            columns: &[IndexColumn {
                expression: "domain",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "helpcenter_domains_is_primary_idx",
            columns: &[IndexColumn {
                expression: "is_primary",
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
