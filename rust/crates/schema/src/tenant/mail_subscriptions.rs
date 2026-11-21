//! `mail_subscriptions`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "mail_subscriptions")]
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
    #[sea_orm(column_type = "String(StringLen::N(320))")]
    #[serde(rename = "senderEmail")]
    pub sender_email: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "senderName")]
    pub sender_name: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "senderDomain")]
    pub sender_domain: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(500))")]
    #[serde(rename = "listId")]
    pub list_id: Option<String>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "unsubscribeUrl")]
    pub unsubscribe_url: Option<String>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "unsubscribeMailto")]
    pub unsubscribe_mailto: Option<String>,
    #[serde(rename = "oneClick")]
    pub one_click: bool,
    #[serde(rename = "messageCount")]
    pub message_count: i32,
    #[sea_orm(column_type = "String(StringLen::N(998))")]
    #[serde(rename = "lastSubject")]
    pub last_subject: Option<String>,
    #[serde(rename = "firstReceivedAt", with = "crate::js::timestamp")]
    pub first_received_at: TimeDateTime,
    #[serde(rename = "lastReceivedAt", with = "crate::js::timestamp")]
    pub last_received_at: TimeDateTime,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "status")]
    pub status: String,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "unsubscribeMethod")]
    pub unsubscribe_method: Option<String>,
    #[serde(rename = "unsubscribedAt", with = "crate::js::timestamp::option")]
    pub unsubscribed_at: Option<TimeDateTime>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "unsubscribedBy")]
    pub unsubscribed_by: Option<String>,
    #[serde(rename = "createdAt", with = "crate::js::timestamp")]
    pub created_at: TimeDateTime,
    #[serde(rename = "updatedAt", with = "crate::js::timestamp")]
    pub updated_at: TimeDateTime,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "mail_subscriptions",
    columns: &[
        DdlColumn {
            name: "one_click",
            sql_type: None,
            default: Some(DdlDefault::Bool(false)),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "message_count",
            sql_type: None,
            default: Some(DdlDefault::Number("0")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "first_received_at",
            sql_type: None,
            default: Some(DdlDefault::Sql("now()")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "last_received_at",
            sql_type: None,
            default: Some(DdlDefault::Sql("now()")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "status",
            sql_type: None,
            default: Some(DdlDefault::Sql("'active'")),
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
            name: "mail_subscriptions_account_sender_uidx",
            columns: &[
                IndexColumn {
                    expression: "account_id",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "sender_email",
                    is_expression: false,
                    asc: true,
                },
            ],
            unique: true,
            method: "btree",
            filter: None,
        },
        Index {
            name: "mail_subscriptions_account_last_received_idx",
            columns: &[
                IndexColumn {
                    expression: "account_id",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "last_received_at",
                    is_expression: false,
                    asc: true,
                },
            ],
            unique: false,
            method: "btree",
            filter: None,
        },
    ],
    foreign_keys: &[ForeignKey {
        name: "mail_subscriptions_account_id_mail_accounts_id_fk",
        columns: &["account_id"],
        references: "mail_accounts",
        referenced_columns: &["id"],
        on_delete: "no action",
        on_update: "no action",
    }],
    uniques: &[],
    checks: &[],
};
