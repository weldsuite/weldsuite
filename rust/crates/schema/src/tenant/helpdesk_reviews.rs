//! `helpdesk_reviews`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "helpdesk_reviews")]
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
    #[sea_orm(column_name = "type", column_type = "String(StringLen::N(20))")]
    #[serde(rename = "type")]
    pub type_: String,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "status")]
    pub status: String,
    #[serde(rename = "rating")]
    pub rating: i32,
    #[sea_orm(column_type = "String(StringLen::N(500))")]
    #[serde(rename = "title")]
    pub title: String,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "content")]
    pub content: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "reviewerId")]
    pub reviewer_id: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "reviewerName")]
    pub reviewer_name: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "reviewerEmail")]
    pub reviewer_email: String,
    #[sea_orm(column_type = "String(StringLen::N(500))")]
    #[serde(rename = "reviewerAvatar")]
    pub reviewer_avatar: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "conversationId")]
    pub conversation_id: Option<String>,
    #[serde(rename = "isVerified")]
    pub is_verified: bool,
    #[serde(rename = "isPinned")]
    pub is_pinned: bool,
    #[serde(rename = "isFeatured")]
    pub is_featured: bool,
    #[serde(rename = "helpfulCount")]
    pub helpful_count: i32,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "helpfulVoters")]
    pub helpful_voters: Option<Json>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "response")]
    pub response: Option<Json>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "metadata")]
    pub metadata: Option<Json>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "helpdesk_reviews",
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
            default: Some(DdlDefault::Sql("'service'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "status",
            sql_type: None,
            default: Some(DdlDefault::Sql("'pending'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "is_verified",
            sql_type: None,
            default: Some(DdlDefault::Bool(false)),
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
            name: "is_featured",
            sql_type: None,
            default: Some(DdlDefault::Bool(false)),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "helpful_count",
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
            name: "helpdesk_reviews_type_idx",
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
            name: "helpdesk_reviews_status_idx",
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
            name: "helpdesk_reviews_rating_idx",
            columns: &[IndexColumn {
                expression: "rating",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "helpdesk_reviews_reviewer_idx",
            columns: &[IndexColumn {
                expression: "reviewer_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "helpdesk_reviews_is_featured_idx",
            columns: &[IndexColumn {
                expression: "is_featured",
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
