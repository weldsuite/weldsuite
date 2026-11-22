//! `mail_attachments`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "mail_attachments")]
pub struct Model {
    #[sea_orm(
        primary_key,
        auto_increment = false,
        column_type = "String(StringLen::N(30))"
    )]
    #[serde(rename = "id")]
    pub id: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "messageId")]
    pub message_id: String,
    #[sea_orm(column_type = "String(StringLen::N(500))")]
    #[serde(rename = "fileName")]
    pub file_name: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "contentType")]
    pub content_type: Option<String>,
    #[serde(rename = "size")]
    pub size: i32,
    #[serde(rename = "isInline")]
    pub is_inline: Option<bool>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "contentId")]
    pub content_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(100))")]
    #[serde(rename = "contentDisposition")]
    pub content_disposition: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(64))")]
    #[serde(rename = "checksum")]
    pub checksum: Option<String>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "downloadUrl")]
    pub download_url: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(1000))")]
    #[serde(rename = "storagePath")]
    pub storage_path: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "externalAttachmentId")]
    pub external_attachment_id: Option<String>,
    /// The virus scan of an inbound attachment (`crates/mail-inbound`'s
    /// `threats`): `clean`, `infected`, `pending` (the scanner was
    /// unreachable; the `mail-attachment-scan` cron settles it) or `error`
    /// (the scanner could not read it). Null: never scanned (older mail,
    /// outbound uploads, scanning off). Infected and pending files are not
    /// served.
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "scanStatus")]
    pub scan_status: Option<String>,
    /// The scanner's signature name for an infected file.
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "scanSignature")]
    pub scan_signature: Option<String>,
    #[serde(rename = "scannedAt", with = "crate::js::timestamp::option")]
    pub scanned_at: Option<TimeDateTime>,
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
    name: "mail_attachments",
    columns: &[
        DdlColumn {
            name: "size",
            sql_type: None,
            default: Some(DdlDefault::Number("0")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "is_inline",
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
            name: "mail_attachments_message_id_idx",
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
            name: "mail_attachments_content_type_idx",
            columns: &[IndexColumn {
                expression: "content_type",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "mail_attachments_is_inline_idx",
            columns: &[IndexColumn {
                expression: "is_inline",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        // The rescan cron's work list: the few attachments still waiting.
        Index {
            name: "mail_attachments_scan_pending_idx",
            columns: &[IndexColumn {
                expression: "created_at",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: Some("\"mail_attachments\".\"scan_status\" = 'pending'"),
        },
    ],
    foreign_keys: &[ForeignKey {
        name: "mail_attachments_message_id_mail_messages_id_fk",
        columns: &["message_id"],
        references: "mail_messages",
        referenced_columns: &["id"],
        on_delete: "no action",
        on_update: "no action",
    }],
    uniques: &[],
    checks: &[],
};
