//! `helpdesk_announcements`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "helpdesk_announcements")]
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
    #[sea_orm(column_type = "String(StringLen::N(500))")]
    #[serde(rename = "title")]
    pub title: String,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "content")]
    pub content: String,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "excerpt")]
    pub excerpt: Option<String>,
    #[sea_orm(column_name = "type", column_type = "String(StringLen::N(20))")]
    #[serde(rename = "type")]
    pub type_: String,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "status")]
    pub status: String,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "visibility")]
    pub visibility: String,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "targetGroups")]
    pub target_groups: Option<Json>,
    #[sea_orm(column_type = "String(StringLen::N(500))")]
    #[serde(rename = "featuredImage")]
    pub featured_image: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "authorId")]
    pub author_id: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "authorName")]
    pub author_name: Option<String>,
    #[serde(rename = "publishedAt", with = "crate::js::timestamp::option")]
    pub published_at: Option<TimeDateTime>,
    #[serde(rename = "expiresAt", with = "crate::js::timestamp::option")]
    pub expires_at: Option<TimeDateTime>,
    #[serde(rename = "isPinned")]
    pub is_pinned: Option<bool>,
    #[serde(rename = "viewCount")]
    pub view_count: Option<i32>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "helpdesk_announcements",
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
            name: "type",
            sql_type: None,
            default: Some(DdlDefault::Sql("'info'")),
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
            name: "visibility",
            sql_type: None,
            default: Some(DdlDefault::Sql("'public'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "is_pinned",
            sql_type: None,
            default: Some(DdlDefault::Bool(false)),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "view_count",
            sql_type: None,
            default: Some(DdlDefault::Number("0")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
    ],
    primary_key: None,
    indexes: &[
        Index {
            name: "helpdesk_announcements_status_idx",
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
            name: "helpdesk_announcements_visibility_idx",
            columns: &[IndexColumn {
                expression: "visibility",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "helpdesk_announcements_type_idx",
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
            name: "helpdesk_announcements_published_at_idx",
            columns: &[IndexColumn {
                expression: "published_at",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "helpdesk_announcements_is_pinned_idx",
            columns: &[IndexColumn {
                expression: "is_pinned",
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
