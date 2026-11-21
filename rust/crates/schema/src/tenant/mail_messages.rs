//! `mail_messages`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "mail_messages")]
pub struct Model {
    #[sea_orm(
        primary_key,
        auto_increment = false,
        column_type = "String(StringLen::N(30))"
    )]
    #[serde(rename = "id")]
    pub id: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "accountId")]
    pub account_id: String,
    #[sea_orm(column_type = "String(StringLen::N(500))")]
    #[serde(rename = "messageId")]
    pub message_id: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "threadId")]
    pub thread_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "conversationId")]
    pub conversation_id: Option<String>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "from")]
    pub from: Json,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "to")]
    pub to: Json,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "cc")]
    pub cc: Option<Json>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "bcc")]
    pub bcc: Option<Json>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "replyTo")]
    pub reply_to: Option<Json>,
    #[sea_orm(column_type = "String(StringLen::N(998))")]
    #[serde(rename = "subject")]
    pub subject: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(500))")]
    #[serde(rename = "preview")]
    pub preview: Option<String>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "textBody")]
    pub text_body: Option<String>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "htmlBody")]
    pub html_body: Option<String>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "rawMessage")]
    pub raw_message: Option<String>,
    #[serde(rename = "sentDate", with = "crate::js::timestamp")]
    pub sent_date: TimeDateTime,
    #[serde(rename = "receivedDate", with = "crate::js::timestamp::option")]
    pub received_date: Option<TimeDateTime>,
    #[serde(rename = "isRead")]
    pub is_read: bool,
    #[serde(rename = "isStarred")]
    pub is_starred: Option<bool>,
    #[serde(rename = "isFlagged")]
    pub is_flagged: Option<bool>,
    #[serde(rename = "isImportant")]
    pub is_important: Option<bool>,
    #[serde(rename = "isDraft")]
    pub is_draft: Option<bool>,
    #[serde(rename = "isSpam")]
    pub is_spam: Option<bool>,
    #[serde(rename = "isTrash")]
    pub is_trash: Option<bool>,
    #[serde(rename = "hasAttachments")]
    pub has_attachments: bool,
    #[serde(rename = "attachmentCount")]
    pub attachment_count: Option<i32>,
    #[sea_orm(column_type = "String(StringLen::N(500))")]
    #[serde(rename = "inReplyTo")]
    pub in_reply_to: Option<String>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "references")]
    pub references: Option<Json>,
    #[serde(rename = "isReply")]
    pub is_reply: Option<bool>,
    #[serde(rename = "isForwarded")]
    pub is_forwarded: Option<bool>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "labels")]
    pub labels: Option<Json>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "categories")]
    pub categories: Option<Json>,
    #[serde(rename = "priority")]
    pub priority: Option<super::enums::MailPriority>,
    #[serde(rename = "readReceipt")]
    pub read_receipt: Option<bool>,
    #[serde(rename = "deliveryReceipt")]
    pub delivery_receipt: Option<bool>,
    #[serde(rename = "openedAt", with = "crate::js::timestamp::option")]
    pub opened_at: Option<TimeDateTime>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "clickedLinks")]
    pub clicked_links: Option<Json>,
    #[serde(rename = "isEncrypted")]
    pub is_encrypted: Option<bool>,
    #[serde(rename = "isSigned")]
    pub is_signed: Option<bool>,
    #[serde(rename = "spfStatus")]
    pub spf_status: Option<super::enums::MailSecurityStatus>,
    #[serde(rename = "dkimStatus")]
    pub dkim_status: Option<super::enums::MailSecurityStatus>,
    #[serde(rename = "dmarcStatus")]
    pub dmarc_status: Option<super::enums::MailSecurityStatus>,
    #[serde(rename = "scheduledFor", with = "crate::js::timestamp::option")]
    pub scheduled_for: Option<TimeDateTime>,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "sendStatus")]
    pub send_status: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "triggerRunId")]
    pub trigger_run_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(50))")]
    #[serde(rename = "sendProvider")]
    pub send_provider: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "providerMessageId")]
    pub provider_message_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "mailgunMessageId")]
    pub mailgun_message_id: Option<String>,
    #[serde(rename = "snoozedUntil", with = "crate::js::timestamp::option")]
    pub snoozed_until: Option<TimeDateTime>,
    #[serde(rename = "snoozedAt", with = "crate::js::timestamp::option")]
    pub snoozed_at: Option<TimeDateTime>,
    #[serde(rename = "unsnoozedAt", with = "crate::js::timestamp::option")]
    pub unsnoozed_at: Option<TimeDateTime>,
    #[serde(rename = "unsnoozedEarly")]
    pub unsnoozed_early: Option<bool>,
    #[serde(rename = "resnoozedAt", with = "crate::js::timestamp::option")]
    pub resnoozed_at: Option<TimeDateTime>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "unsnoozeTriggerRunId")]
    pub unsnooze_trigger_run_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "deliveryStatus")]
    pub delivery_status: Option<String>,
    #[serde(rename = "deliveryUpdatedAt", with = "crate::js::timestamp::option")]
    pub delivery_updated_at: Option<TimeDateTime>,
    #[sea_orm(column_type = "String(StringLen::N(500))")]
    #[serde(rename = "deliveryDetail")]
    pub delivery_detail: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "source")]
    pub source: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(64))")]
    #[serde(rename = "idempotencyKey")]
    pub idempotency_key: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "externalMessageId")]
    pub external_message_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "mailcowMessageId")]
    pub mailcow_message_id: Option<String>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "headers")]
    pub headers: Option<Json>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "customFields")]
    pub custom_fields: Option<Json>,
    #[serde(rename = "sizeBytes")]
    pub size_bytes: Option<i32>,
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
    name: "mail_messages",
    columns: &[
        DdlColumn {
            name: "is_read",
            sql_type: None,
            default: Some(DdlDefault::Bool(false)),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "is_starred",
            sql_type: None,
            default: Some(DdlDefault::Bool(false)),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "is_flagged",
            sql_type: None,
            default: Some(DdlDefault::Bool(false)),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "is_important",
            sql_type: None,
            default: Some(DdlDefault::Bool(false)),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "is_draft",
            sql_type: None,
            default: Some(DdlDefault::Bool(false)),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "is_spam",
            sql_type: None,
            default: Some(DdlDefault::Bool(false)),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "is_trash",
            sql_type: None,
            default: Some(DdlDefault::Bool(false)),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "has_attachments",
            sql_type: None,
            default: Some(DdlDefault::Bool(false)),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "attachment_count",
            sql_type: None,
            default: Some(DdlDefault::Number("0")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "is_reply",
            sql_type: None,
            default: Some(DdlDefault::Bool(false)),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "is_forwarded",
            sql_type: None,
            default: Some(DdlDefault::Bool(false)),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "priority",
            sql_type: None,
            default: Some(DdlDefault::Sql("'normal'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "read_receipt",
            sql_type: None,
            default: Some(DdlDefault::Bool(false)),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "delivery_receipt",
            sql_type: None,
            default: Some(DdlDefault::Bool(false)),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "is_encrypted",
            sql_type: None,
            default: Some(DdlDefault::Bool(false)),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "is_signed",
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
            name: "mail_messages_account_id_idx",
            columns: &[IndexColumn {
                expression: "account_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "mail_messages_message_id_idx",
            columns: &[IndexColumn {
                expression: "message_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "mail_messages_thread_id_idx",
            columns: &[IndexColumn {
                expression: "thread_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "mail_messages_is_read_idx",
            columns: &[IndexColumn {
                expression: "is_read",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "mail_messages_sent_date_idx",
            columns: &[IndexColumn {
                expression: "sent_date",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "mail_messages_external_message_id_idx",
            columns: &[IndexColumn {
                expression: "external_message_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "mail_messages_labels_gin",
            columns: &[IndexColumn {
                expression: "labels",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "gin",
            filter: None,
        },
        Index {
            name: "mail_messages_snoozed_until_idx",
            columns: &[IndexColumn {
                expression: "snoozed_until",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "mail_messages_scheduled_for_idx",
            columns: &[IndexColumn {
                expression: "scheduled_for",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "mail_messages_account_thread_key_idx",
            columns: &[
                IndexColumn {
                    expression: "account_id",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "COALESCE(\"thread_id\", \"id\")",
                    is_expression: true,
                    asc: true,
                },
            ],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "mail_messages_account_sent_date_idx",
            columns: &[
                IndexColumn {
                    expression: "account_id",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "sent_date",
                    is_expression: false,
                    asc: false,
                },
            ],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "mail_messages_account_idempotency_idx",
            columns: &[
                IndexColumn {
                    expression: "account_id",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "idempotency_key",
                    is_expression: false,
                    asc: true,
                },
            ],
            unique: true,
            method: "btree",
            filter: None,
        },
    ],
    foreign_keys: &[ForeignKey {
        name: "mail_messages_account_id_mail_accounts_id_fk",
        columns: &["account_id"],
        references: "mail_accounts",
        referenced_columns: &["id"],
        on_delete: "no action",
        on_update: "no action",
    }],
    uniques: &[],
    checks: &[],
};
