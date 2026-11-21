//! `desk_messages`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "desk_messages")]
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
    #[serde(rename = "conversationId")]
    pub conversation_id: String,
    #[sea_orm(column_type = "String(StringLen::N(10))")]
    #[serde(rename = "kind")]
    pub kind: String,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "body")]
    pub body: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(10))")]
    #[serde(rename = "authorType")]
    pub author_type: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "authorId")]
    pub author_id: Option<String>,
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
    name: "desk_messages",
    columns: &[DdlColumn {
        name: "created_at",
        sql_type: None,
        default: Some(DdlDefault::Sql("now()")),
        generated: None,
        default_fn: false,
        on_update: false,
    }],
    primary_key: None,
    indexes: &[
        Index {
            name: "desk_messages_conversation_created_idx",
            columns: &[
                IndexColumn {
                    expression: "conversation_id",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "created_at",
                    is_expression: false,
                    asc: true,
                },
            ],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "desk_messages_kind_idx",
            columns: &[IndexColumn {
                expression: "kind",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "desk_messages_author_idx",
            columns: &[
                IndexColumn {
                    expression: "author_type",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "author_id",
                    is_expression: false,
                    asc: true,
                },
            ],
            unique: false,
            method: "btree",
            filter: None,
        },
    ],
    foreign_keys: &[],
    uniques: &[],
    checks: &[],
};
