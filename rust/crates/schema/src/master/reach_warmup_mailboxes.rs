//! `reach_warmup_mailboxes`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "reach_warmup_mailboxes")]
pub struct Model {
    #[sea_orm(
        primary_key,
        auto_increment = false,
        column_type = "String(StringLen::N(30))"
    )]
    #[serde(rename = "id")]
    pub id: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "workspaceId")]
    pub workspace_id: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "clerkOrgId")]
    pub clerk_org_id: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "tenantMailboxId")]
    pub tenant_mailbox_id: String,
    #[sea_orm(column_type = "String(StringLen::N(320))")]
    #[serde(rename = "email")]
    pub email: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "domain")]
    pub domain: String,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "mailboxType")]
    pub mailbox_type: String,
    #[sea_orm(column_type = "String(StringLen::N(100))")]
    #[serde(rename = "firstName")]
    pub first_name: String,
    #[sea_orm(column_type = "String(StringLen::N(100))")]
    #[serde(rename = "lastName")]
    pub last_name: String,
    #[sea_orm(column_type = "String(StringLen::N(64))")]
    #[serde(rename = "timezone")]
    pub timezone: String,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "status")]
    pub status: String,
    #[serde(rename = "startedAt", with = "crate::js::timestamptz::option")]
    pub started_at: Option<TimeDateTimeWithTimeZone>,
    #[serde(rename = "rampDay")]
    pub ramp_day: i32,
    #[serde(rename = "rampUpdatedAt", with = "crate::js::timestamptz::option")]
    pub ramp_updated_at: Option<TimeDateTimeWithTimeZone>,
    #[serde(rename = "dailyTarget")]
    pub daily_target: i32,
    #[sea_orm(column_type = "String(StringLen::N(10))")]
    #[serde(rename = "plannedFor")]
    pub planned_for: Option<String>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "smtpCredentials")]
    pub smtp_credentials: String,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "imapCredentials")]
    pub imap_credentials: String,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "stats")]
    pub stats: Option<Json>,
    #[sea_orm(column_type = "String(StringLen::N(100))")]
    #[serde(rename = "pausedReason")]
    pub paused_reason: Option<String>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "lastLoginError")]
    pub last_login_error: Option<String>,
    #[serde(rename = "lastLoginErrorAt", with = "crate::js::timestamptz::option")]
    pub last_login_error_at: Option<TimeDateTimeWithTimeZone>,
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
    name: "reach_warmup_mailboxes",
    columns: &[
        DdlColumn {
            name: "timezone",
            sql_type: None,
            default: Some(DdlDefault::Sql("'Europe/Amsterdam'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "status",
            sql_type: None,
            default: Some(DdlDefault::Sql("'waiting'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "ramp_day",
            sql_type: None,
            default: Some(DdlDefault::Number("0")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "daily_target",
            sql_type: None,
            default: Some(DdlDefault::Number("0")),
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
            name: "reach_warmup_mailboxes_tenant_idx",
            columns: &[
                IndexColumn {
                    expression: "clerk_org_id",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "tenant_mailbox_id",
                    is_expression: false,
                    asc: true,
                },
            ],
            unique: true,
            method: "btree",
            filter: None,
        },
        Index {
            name: "reach_warmup_mailboxes_email_idx",
            columns: &[IndexColumn {
                expression: "email",
                is_expression: false,
                asc: true,
            }],
            unique: true,
            method: "btree",
            filter: None,
        },
        Index {
            name: "reach_warmup_mailboxes_status_idx",
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
            name: "reach_warmup_mailboxes_workspace_idx",
            columns: &[IndexColumn {
                expression: "workspace_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "reach_warmup_mailboxes_domain_idx",
            columns: &[IndexColumn {
                expression: "domain",
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
