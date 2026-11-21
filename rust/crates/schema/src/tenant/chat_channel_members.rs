//! `chat_channel_members`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "chat_channel_members")]
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
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "channelId")]
    pub channel_id: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "userId")]
    pub user_id: String,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "memberType")]
    pub member_type: String,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "role")]
    pub role: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "addedByRoleId")]
    pub added_by_role_id: Option<String>,
    #[serde(rename = "lastReadAt", with = "crate::js::timestamp::option")]
    pub last_read_at: Option<TimeDateTime>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "lastReadMessageId")]
    pub last_read_message_id: Option<String>,
    #[serde(rename = "isMuted")]
    pub is_muted: bool,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "notificationPreference")]
    pub notification_preference: String,
    #[serde(rename = "unreadMentionCount")]
    pub unread_mention_count: i32,
    #[serde(rename = "joinedAt", with = "crate::js::timestamp")]
    pub joined_at: TimeDateTime,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "chat_channel_members",
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
            name: "member_type",
            sql_type: None,
            default: Some(DdlDefault::Sql("'user'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "role",
            sql_type: None,
            default: Some(DdlDefault::Sql("'member'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "is_muted",
            sql_type: None,
            default: Some(DdlDefault::Bool(false)),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "notification_preference",
            sql_type: None,
            default: Some(DdlDefault::Sql("'all'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "unread_mention_count",
            sql_type: None,
            default: Some(DdlDefault::Number("0")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "joined_at",
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
            name: "chat_channel_members_unique_idx",
            columns: &[
                IndexColumn {
                    expression: "channel_id",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "user_id",
                    is_expression: false,
                    asc: true,
                },
            ],
            unique: true,
            method: "btree",
            filter: None,
        },
        Index {
            name: "chat_channel_members_channel_idx",
            columns: &[IndexColumn {
                expression: "channel_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "chat_channel_members_user_idx",
            columns: &[IndexColumn {
                expression: "user_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
    ],
    foreign_keys: &[
        ForeignKey {
            name: "chat_channel_members_channel_id_chat_channels_id_fk",
            columns: &["channel_id"],
            references: "chat_channels",
            referenced_columns: &["id"],
            on_delete: "no action",
            on_update: "no action",
        },
        ForeignKey {
            name: "chat_channel_members_added_by_role_id_roles_id_fk",
            columns: &["added_by_role_id"],
            references: "roles",
            referenced_columns: &["id"],
            on_delete: "set null",
            on_update: "no action",
        },
    ],
    uniques: &[],
    checks: &[],
};
