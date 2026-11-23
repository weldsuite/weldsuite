//! `social_approval_history`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "social_approval_history")]
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
    #[serde(rename = "approvalId")]
    pub approval_id: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "postId")]
    pub post_id: String,
    #[serde(rename = "action")]
    pub action: super::enums::SocialApprovalAction,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "actorUserId")]
    pub actor_user_id: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "actorName")]
    pub actor_name: Option<String>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "notes")]
    pub notes: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "previousStatus")]
    pub previous_status: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "newStatus")]
    pub new_status: Option<String>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "postSnapshot")]
    pub post_snapshot: Option<Json>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "metadata")]
    pub metadata: Option<Json>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "social_approval_history",
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
            name: "social_approval_history_approval_idx",
            columns: &[IndexColumn {
                expression: "approval_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "social_approval_history_post_idx",
            columns: &[IndexColumn {
                expression: "post_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "social_approval_history_actor_idx",
            columns: &[IndexColumn {
                expression: "actor_user_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "social_approval_history_created_at_idx",
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
    foreign_keys: &[
        ForeignKey {
            name: "social_approval_history_approval_id_social_approvals_id_fk",
            columns: &["approval_id"],
            references: "social_approvals",
            referenced_columns: &["id"],
            on_delete: "no action",
            on_update: "no action",
        },
        ForeignKey {
            name: "social_approval_history_post_id_social_posts_id_fk",
            columns: &["post_id"],
            references: "social_posts",
            referenced_columns: &["id"],
            on_delete: "no action",
            on_update: "no action",
        },
    ],
    uniques: &[],
    checks: &[],
};
