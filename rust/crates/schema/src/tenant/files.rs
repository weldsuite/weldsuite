//! `files`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "files")]
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
    #[sea_orm(column_type = "String(StringLen::N(500))")]
    #[serde(rename = "fileName")]
    pub file_name: String,
    #[sea_orm(column_type = "String(StringLen::N(500))")]
    #[serde(rename = "originalName")]
    pub original_name: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "mimeType")]
    pub mime_type: String,
    #[serde(rename = "fileSize")]
    pub file_size: i32,
    #[sea_orm(column_type = "String(StringLen::N(50))")]
    #[serde(rename = "fileType")]
    pub file_type: String,
    #[sea_orm(column_type = "String(StringLen::N(1000))")]
    #[serde(rename = "storagePath")]
    pub storage_path: String,
    #[sea_orm(column_type = "String(StringLen::N(1000))")]
    #[serde(rename = "fileKey")]
    pub file_key: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "bucket")]
    pub bucket: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(1000))")]
    #[serde(rename = "url")]
    pub url: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(1000))")]
    #[serde(rename = "thumbnailUrl")]
    pub thumbnail_url: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(50))")]
    #[serde(rename = "storageProvider")]
    pub storage_provider: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "folderId")]
    pub folder_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "uploadedById")]
    pub uploaded_by_id: Option<String>,
    #[serde(rename = "isPublic")]
    pub is_public: bool,
    #[serde(rename = "clientVisible")]
    pub client_visible: bool,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "generalAccess")]
    pub general_access: String,
    #[serde(rename = "isStarred")]
    pub is_starred: bool,
    #[serde(rename = "isPinned")]
    pub is_pinned: bool,
    #[serde(rename = "pinnedAt", with = "crate::js::timestamp::option")]
    pub pinned_at: Option<TimeDateTime>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "pinnedBy")]
    pub pinned_by: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(100))")]
    #[serde(rename = "entityType")]
    pub entity_type: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "entityId")]
    pub entity_id: Option<String>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "metadata")]
    pub metadata: Option<Json>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "files",
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
            name: "file_type",
            sql_type: None,
            default: Some(DdlDefault::Sql("'file'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "storage_provider",
            sql_type: None,
            default: Some(DdlDefault::Sql("'r2'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "is_public",
            sql_type: None,
            default: Some(DdlDefault::Bool(false)),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "client_visible",
            sql_type: None,
            default: Some(DdlDefault::Bool(false)),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "general_access",
            sql_type: None,
            default: Some(DdlDefault::Sql("'workspace_edit'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "is_starred",
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
    ],
    primary_key: None,
    indexes: &[
        Index {
            name: "files_folder_idx",
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
            name: "files_uploaded_by_idx",
            columns: &[IndexColumn {
                expression: "uploaded_by_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "files_file_type_idx",
            columns: &[IndexColumn {
                expression: "file_type",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "files_entity_idx",
            columns: &[
                IndexColumn {
                    expression: "entity_type",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "entity_id",
                    is_expression: false,
                    asc: true,
                },
            ],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "files_is_pinned_idx",
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
    foreign_keys: &[ForeignKey {
        name: "files_folder_id_folders_id_fk",
        columns: &["folder_id"],
        references: "folders",
        referenced_columns: &["id"],
        on_delete: "no action",
        on_update: "no action",
    }],
    uniques: &[],
    checks: &[],
};
