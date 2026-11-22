//! `merge_pull_requests`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "merge_pull_requests")]
pub struct Model {
    #[sea_orm(
        primary_key,
        auto_increment = false,
        column_type = "String(StringLen::N(30))"
    )]
    #[serde(rename = "id")]
    pub id: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "repositoryId")]
    pub repository_id: String,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "provider")]
    pub provider: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "externalId")]
    pub external_id: String,
    #[serde(rename = "number")]
    pub number: i32,
    #[sea_orm(column_type = "String(StringLen::N(1000))")]
    #[serde(rename = "title")]
    pub title: String,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "body")]
    pub body: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "state")]
    pub state: String,
    #[serde(rename = "draft")]
    pub draft: bool,
    #[sea_orm(column_type = "String(StringLen::N(1000))")]
    #[serde(rename = "url")]
    pub url: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "authorLogin")]
    pub author_login: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(1000))")]
    #[serde(rename = "authorAvatarUrl")]
    pub author_avatar_url: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "authorUserId")]
    pub author_user_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(500))")]
    #[serde(rename = "headRef")]
    pub head_ref: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(500))")]
    #[serde(rename = "baseRef")]
    pub base_ref: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(64))")]
    #[serde(rename = "headSha")]
    pub head_sha: Option<String>,
    #[serde(rename = "additions")]
    pub additions: Option<i32>,
    #[serde(rename = "deletions")]
    pub deletions: Option<i32>,
    #[serde(rename = "changedFiles")]
    pub changed_files: Option<i32>,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "checksStatus")]
    pub checks_status: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "reviewDecision")]
    pub review_decision: Option<String>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "requestedReviewers")]
    pub requested_reviewers: Json,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "labels")]
    pub labels: Json,
    #[serde(rename = "providerCreatedAt", with = "crate::js::timestamptz")]
    pub provider_created_at: TimeDateTimeWithTimeZone,
    #[serde(rename = "providerUpdatedAt", with = "crate::js::timestamptz")]
    pub provider_updated_at: TimeDateTimeWithTimeZone,
    #[serde(rename = "mergedAt", with = "crate::js::timestamptz::option")]
    pub merged_at: Option<TimeDateTimeWithTimeZone>,
    #[serde(rename = "closedAt", with = "crate::js::timestamptz::option")]
    pub closed_at: Option<TimeDateTimeWithTimeZone>,
    #[serde(rename = "syncedAt", with = "crate::js::timestamptz")]
    pub synced_at: TimeDateTimeWithTimeZone,
    #[serde(rename = "createdAt", with = "crate::js::timestamptz")]
    pub created_at: TimeDateTimeWithTimeZone,
    #[serde(rename = "updatedAt", with = "crate::js::timestamptz")]
    pub updated_at: TimeDateTimeWithTimeZone,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "merge_pull_requests",
    columns: &[
        DdlColumn {
            name: "draft",
            sql_type: None,
            default: Some(DdlDefault::Bool(false)),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "requested_reviewers",
            sql_type: None,
            default: Some(DdlDefault::Sql("'[]'::jsonb")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "labels",
            sql_type: None,
            default: Some(DdlDefault::Sql("'[]'::jsonb")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "synced_at",
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
            name: "merge_pull_requests_repo_number_idx",
            columns: &[
                IndexColumn {
                    expression: "repository_id",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "number",
                    is_expression: false,
                    asc: true,
                },
            ],
            unique: true,
            method: "btree",
            filter: None,
        },
        Index {
            name: "merge_pull_requests_state_idx",
            columns: &[
                IndexColumn {
                    expression: "state",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "provider_updated_at",
                    is_expression: false,
                    asc: true,
                },
            ],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "merge_pull_requests_author_idx",
            columns: &[IndexColumn {
                expression: "author_user_id",
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
