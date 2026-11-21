//! `chat_drafts`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "chat_drafts")]
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
    #[serde(rename = "userId")]
    pub user_id: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "channelId")]
    pub channel_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "threadParentMessageId")]
    pub thread_parent_message_id: Option<String>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "content")]
    pub content: String,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "attachments")]
    pub attachments: Option<Json>,
    #[serde(rename = "updatedAt", with = "crate::js::timestamp")]
    pub updated_at: TimeDateTime,
    #[serde(rename = "createdAt", with = "crate::js::timestamp")]
    pub created_at: TimeDateTime,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "chat_drafts",
    columns: &[
        DdlColumn {
            name: "updated_at",
            sql_type: None,
            default: Some(DdlDefault::Sql("now()")),
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
    ],
    primary_key: None,
    indexes: &[Index {
        name: "chat_drafts_user_workspace_idx",
        columns: &[
            IndexColumn {
                expression: "user_id",
                is_expression: false,
                asc: true,
            },
            IndexColumn {
                expression: "workspace_id",
                is_expression: false,
                asc: true,
            },
        ],
        unique: false,
        method: "btree",
        filter: None,
    }],
    foreign_keys: &[],
    uniques: &[Unique {
        name: "chat_drafts_location_unique",
        columns: &["user_id", "channel_id", "thread_parent_message_id"],
        nulls_not_distinct: true,
    }],
    checks: &[],
};
