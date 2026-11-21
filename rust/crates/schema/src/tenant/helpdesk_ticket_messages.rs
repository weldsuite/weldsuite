//! `helpdesk_ticket_messages`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "helpdesk_ticket_messages")]
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
    #[serde(rename = "ticketId")]
    pub ticket_id: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "authorId")]
    pub author_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "authorName")]
    pub author_name: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "authorEmail")]
    pub author_email: String,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "authorType")]
    pub author_type: String,
    #[sea_orm(column_type = "String(StringLen::N(500))")]
    #[serde(rename = "subject")]
    pub subject: Option<String>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "body")]
    pub body: String,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "htmlBody")]
    pub html_body: Option<String>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "plainBody")]
    pub plain_body: Option<String>,
    #[sea_orm(column_name = "type", column_type = "String(StringLen::N(20))")]
    #[serde(rename = "type")]
    pub type_: String,
    #[serde(rename = "isPublic")]
    pub is_public: bool,
    #[serde(rename = "isInternal")]
    pub is_internal: Option<bool>,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "status")]
    pub status: Option<String>,
    #[serde(rename = "readAt", with = "crate::js::timestamp::option")]
    pub read_at: Option<TimeDateTime>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "messageId")]
    pub message_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "inReplyTo")]
    pub in_reply_to: Option<String>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "cc")]
    pub cc: Option<Json>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "bcc")]
    pub bcc: Option<Json>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "attachments")]
    pub attachments: Option<Json>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "metadata")]
    pub metadata: Option<Json>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "helpdesk_ticket_messages",
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
            name: "author_type",
            sql_type: None,
            default: Some(DdlDefault::Sql("'customer'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "type",
            sql_type: None,
            default: Some(DdlDefault::Sql("'reply'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "is_public",
            sql_type: None,
            default: Some(DdlDefault::Bool(true)),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "is_internal",
            sql_type: None,
            default: Some(DdlDefault::Bool(false)),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "status",
            sql_type: None,
            default: Some(DdlDefault::Sql("'sent'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
    ],
    primary_key: None,
    indexes: &[
        Index {
            name: "helpdesk_ticket_messages_ticket_idx",
            columns: &[IndexColumn {
                expression: "ticket_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "helpdesk_ticket_messages_author_idx",
            columns: &[IndexColumn {
                expression: "author_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "helpdesk_ticket_messages_author_type_idx",
            columns: &[IndexColumn {
                expression: "author_type",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "helpdesk_ticket_messages_type_idx",
            columns: &[IndexColumn {
                expression: "type",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "helpdesk_ticket_messages_is_public_idx",
            columns: &[IndexColumn {
                expression: "is_public",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "helpdesk_ticket_messages_created_at_idx",
            columns: &[IndexColumn {
                expression: "created_at",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
    ],
    foreign_keys: &[ForeignKey {
        name: "helpdesk_ticket_messages_ticket_id_helpdesk_tickets_id_fk",
        columns: &["ticket_id"],
        references: "helpdesk_tickets",
        referenced_columns: &["id"],
        on_delete: "no action",
        on_update: "no action",
    }],
    uniques: &[],
    checks: &[],
};
