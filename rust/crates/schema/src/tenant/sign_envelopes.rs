//! `sign_envelopes`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "sign_envelopes")]
pub struct Model {
    #[sea_orm(
        primary_key,
        auto_increment = false,
        column_type = "String(StringLen::N(30))"
    )]
    #[serde(rename = "id")]
    pub id: String,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "kind")]
    pub kind: String,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "status")]
    pub status: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "title")]
    pub title: String,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "message")]
    pub message: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "senderUserId")]
    pub sender_user_id: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "senderName")]
    pub sender_name: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(320))")]
    #[serde(rename = "senderEmail")]
    pub sender_email: Option<String>,
    #[serde(rename = "signingOrderEnabled")]
    pub signing_order_enabled: bool,
    #[serde(rename = "expiresAt", with = "crate::js::timestamptz::option")]
    pub expires_at: Option<TimeDateTimeWithTimeZone>,
    #[serde(rename = "reminderAfterDays")]
    pub reminder_after_days: Option<i32>,
    #[serde(rename = "reminderEveryDays")]
    pub reminder_every_days: Option<i32>,
    #[serde(rename = "reminderMaxCount")]
    pub reminder_max_count: Option<i32>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "source")]
    pub source: Option<Json>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "fileBackFolderId")]
    pub file_back_folder_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "templateId")]
    pub template_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(64))")]
    #[serde(rename = "finalSha256")]
    pub final_sha256: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(1000))")]
    #[serde(rename = "finalStorageKey")]
    pub final_storage_key: Option<String>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "voidedReason")]
    pub voided_reason: Option<String>,
    #[serde(rename = "sentAt", with = "crate::js::timestamptz::option")]
    pub sent_at: Option<TimeDateTimeWithTimeZone>,
    #[serde(rename = "completedAt", with = "crate::js::timestamptz::option")]
    pub completed_at: Option<TimeDateTimeWithTimeZone>,
    #[serde(rename = "voidedAt", with = "crate::js::timestamptz::option")]
    pub voided_at: Option<TimeDateTimeWithTimeZone>,
    #[serde(rename = "createdAt", with = "crate::js::timestamptz")]
    pub created_at: TimeDateTimeWithTimeZone,
    #[serde(rename = "updatedAt", with = "crate::js::timestamptz")]
    pub updated_at: TimeDateTimeWithTimeZone,
    #[serde(rename = "deletedAt", with = "crate::js::timestamptz::option")]
    pub deleted_at: Option<TimeDateTimeWithTimeZone>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "sign_envelopes",
    columns: &[
        DdlColumn {
            name: "kind",
            sql_type: None,
            default: Some(DdlDefault::Sql("'envelope'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "status",
            sql_type: None,
            default: Some(DdlDefault::Sql("'draft'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "signing_order_enabled",
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
            name: "sign_envelopes_kind_status_idx",
            columns: &[
                IndexColumn {
                    expression: "kind",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "status",
                    is_expression: false,
                    asc: true,
                },
            ],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "sign_envelopes_sender_idx",
            columns: &[IndexColumn {
                expression: "sender_user_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "sign_envelopes_sent_at_idx",
            columns: &[IndexColumn {
                expression: "sent_at",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "sign_envelopes_expires_at_idx",
            columns: &[IndexColumn {
                expression: "expires_at",
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
