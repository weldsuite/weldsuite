//! `knowledge_pages`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "knowledge_pages")]
pub struct Model {
    #[sea_orm(
        primary_key,
        auto_increment = false,
        column_type = "String(StringLen::N(255))"
    )]
    #[serde(rename = "id")]
    pub id: String,
    #[serde(rename = "createdAt", with = "crate::js::timestamp")]
    pub created_at: TimeDateTime,
    #[serde(rename = "updatedAt", with = "crate::js::timestamp")]
    pub updated_at: TimeDateTime,
    #[serde(rename = "deletedAt", with = "crate::js::timestamp::option")]
    pub deleted_at: Option<TimeDateTime>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "spaceId")]
    pub space_id: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "parentId")]
    pub parent_id: Option<String>,
    #[serde(rename = "position")]
    pub position: i32,
    #[sea_orm(column_type = "String(StringLen::N(500))")]
    #[serde(rename = "title")]
    pub title: String,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "contentJson")]
    pub content_json: Option<Json>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "contentText")]
    pub content_text: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(100))")]
    #[serde(rename = "icon")]
    pub icon: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(1000))")]
    #[serde(rename = "coverImage")]
    pub cover_image: Option<String>,
    #[serde(rename = "isLocked")]
    pub is_locked: bool,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "createdBy")]
    pub created_by: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "lastEditedBy")]
    pub last_edited_by: Option<String>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "knowledge_pages",
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
            name: "position",
            sql_type: None,
            default: Some(DdlDefault::Number("0")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "title",
            sql_type: None,
            default: Some(DdlDefault::Sql("'Untitled'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "is_locked",
            sql_type: None,
            default: Some(DdlDefault::Bool(false)),
            generated: None,
            default_fn: false,
            on_update: false,
        },
    ],
    primary_key: None,
    indexes: &[
        Index {
            name: "knowledge_pages_space_idx",
            columns: &[IndexColumn {
                expression: "space_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "knowledge_pages_parent_idx",
            columns: &[IndexColumn {
                expression: "parent_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "knowledge_pages_parent_position_idx",
            columns: &[
                IndexColumn {
                    expression: "parent_id",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "position",
                    is_expression: false,
                    asc: true,
                },
            ],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "knowledge_pages_deleted_idx",
            columns: &[IndexColumn {
                expression: "deleted_at",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
    ],
    foreign_keys: &[ForeignKey {
        name: "knowledge_pages_space_id_knowledge_spaces_id_fk",
        columns: &["space_id"],
        references: "knowledge_spaces",
        referenced_columns: &["id"],
        on_delete: "no action",
        on_update: "no action",
    }],
    uniques: &[],
    checks: &[],
};
