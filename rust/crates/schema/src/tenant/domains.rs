//! `domains`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "domains")]
pub struct Model {
    #[sea_orm(
        primary_key,
        auto_increment = false,
        column_type = "String(StringLen::N(30))"
    )]
    #[serde(rename = "id")]
    pub id: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "name")]
    pub name: String,
    #[sea_orm(column_type = "String(StringLen::N(50))")]
    #[serde(rename = "tld")]
    pub tld: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "fullDomain")]
    pub full_domain: String,
    #[serde(rename = "status")]
    pub status: super::enums::HostDomainStatus,
    #[serde(rename = "registrationStatus")]
    pub registration_status: Option<super::enums::HostDomainRegistrationStatus>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "registrar")]
    pub registrar: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "externalRegistrarId")]
    pub external_registrar_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(100))")]
    #[serde(rename = "registrarStatus")]
    pub registrar_status: Option<String>,
    #[serde(rename = "registrarSyncedAt", with = "crate::js::timestamp::option")]
    pub registrar_synced_at: Option<TimeDateTime>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "workflowUrl")]
    pub workflow_url: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(40))")]
    #[serde(rename = "rtrRegistrantHandle")]
    pub rtr_registrant_handle: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(64))")]
    #[serde(rename = "rtrProcessId")]
    pub rtr_process_id: Option<String>,
    #[serde(rename = "registeredAt", with = "crate::js::timestamp::option")]
    pub registered_at: Option<TimeDateTime>,
    #[serde(rename = "expiresAt", with = "crate::js::timestamp::option")]
    pub expires_at: Option<TimeDateTime>,
    #[serde(rename = "renewedAt", with = "crate::js::timestamp::option")]
    pub renewed_at: Option<TimeDateTime>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "nameservers")]
    pub nameservers: Option<Json>,
    #[serde(rename = "customNameservers")]
    pub custom_nameservers: Option<bool>,
    #[serde(rename = "nameserverVerified")]
    pub nameserver_verified: Option<bool>,
    #[serde(rename = "nameserverVerificationPending")]
    pub nameserver_verification_pending: Option<bool>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "nameserverVerificationToken")]
    pub nameserver_verification_token: Option<String>,
    #[serde(rename = "autoRenew")]
    pub auto_renew: Option<bool>,
    #[serde(rename = "privacyProtection")]
    pub privacy_protection: Option<bool>,
    #[serde(rename = "locked")]
    pub locked: Option<bool>,
    #[serde(rename = "sslEnabled")]
    pub ssl_enabled: Option<bool>,
    #[serde(rename = "emailForwardingEnabled")]
    pub email_forwarding_enabled: Option<bool>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "stripeSessionId")]
    pub stripe_session_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "authCode")]
    pub auth_code: Option<String>,
    #[serde(rename = "authCodeExpiresAt", with = "crate::js::timestamp::option")]
    pub auth_code_expires_at: Option<TimeDateTime>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "registrantContact")]
    pub registrant_contact: Option<Json>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "adminContact")]
    pub admin_contact: Option<Json>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "techContact")]
    pub tech_contact: Option<Json>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "billingContact")]
    pub billing_contact: Option<Json>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "notes")]
    pub notes: Option<String>,
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
    name: "domains",
    columns: &[
        DdlColumn {
            name: "status",
            sql_type: None,
            default: Some(DdlDefault::Sql("'pending'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "custom_nameservers",
            sql_type: None,
            default: Some(DdlDefault::Bool(false)),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "nameserver_verified",
            sql_type: None,
            default: Some(DdlDefault::Bool(false)),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "nameserver_verification_pending",
            sql_type: None,
            default: Some(DdlDefault::Bool(false)),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "auto_renew",
            sql_type: None,
            default: Some(DdlDefault::Bool(true)),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "privacy_protection",
            sql_type: None,
            default: Some(DdlDefault::Bool(false)),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "locked",
            sql_type: None,
            default: Some(DdlDefault::Bool(true)),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "ssl_enabled",
            sql_type: None,
            default: Some(DdlDefault::Bool(false)),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "email_forwarding_enabled",
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
            name: "domains_full_domain_idx",
            columns: &[IndexColumn {
                expression: "full_domain",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "domains_status_idx",
            columns: &[IndexColumn {
                expression: "status",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "domains_expires_at_idx",
            columns: &[IndexColumn {
                expression: "expires_at",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "domains_external_registrar_id_idx",
            columns: &[IndexColumn {
                expression: "external_registrar_id",
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
