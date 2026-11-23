//! `forms`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "forms")]
pub struct Model {
    #[sea_orm(
        primary_key,
        auto_increment = false,
        column_type = "String(StringLen::N(30))"
    )]
    #[serde(rename = "id")]
    pub id: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "folderId")]
    pub folder_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "title")]
    pub title: String,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "status")]
    pub status: String,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "definition")]
    pub definition: Json,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "settings")]
    pub settings: Json,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "themeId")]
    pub theme_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "publicId")]
    pub public_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "publishedVersionId")]
    pub published_version_id: Option<String>,
    #[serde(rename = "hasUnpublishedChanges")]
    pub has_unpublished_changes: bool,
    #[serde(rename = "revision")]
    pub revision: i32,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "access")]
    pub access: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "ownerUserId")]
    pub owner_user_id: String,
    #[serde(rename = "responseCount")]
    pub response_count: i32,
    #[serde(rename = "responseCounter")]
    pub response_counter: i32,
    #[serde(rename = "lastResponseAt", with = "crate::js::timestamptz::option")]
    pub last_response_at: Option<TimeDateTimeWithTimeZone>,
    #[serde(rename = "publishedAt", with = "crate::js::timestamptz::option")]
    pub published_at: Option<TimeDateTimeWithTimeZone>,
    #[serde(rename = "closedAt", with = "crate::js::timestamptz::option")]
    pub closed_at: Option<TimeDateTimeWithTimeZone>,
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
    name: "forms",
    columns: &[
        DdlColumn {
            name: "status",
            sql_type: None,
            default: Some(DdlDefault::Sql("'draft'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "has_unpublished_changes",
            sql_type: None,
            default: Some(DdlDefault::Bool(false)),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "revision",
            sql_type: None,
            default: Some(DdlDefault::Number("1")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "access",
            sql_type: None,
            default: Some(DdlDefault::Sql("'workspace'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "response_count",
            sql_type: None,
            default: Some(DdlDefault::Number("0")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "response_counter",
            sql_type: None,
            default: Some(DdlDefault::Number("0")),
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
            name: "forms_public_id_idx",
            columns: &[IndexColumn {
                expression: "public_id",
                is_expression: false,
                asc: true,
            }],
            unique: true,
            method: "btree",
            filter: None,
        },
        Index {
            name: "forms_folder_idx",
            columns: &[IndexColumn {
                expression: "folder_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "forms_owner_idx",
            columns: &[IndexColumn {
                expression: "owner_user_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "forms_status_idx",
            columns: &[IndexColumn {
                expression: "status",
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
