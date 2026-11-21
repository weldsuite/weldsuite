//! `drive_shares`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "drive_shares")]
pub struct Model {
    #[sea_orm(
        primary_key,
        auto_increment = false,
        column_type = "String(StringLen::N(30))"
    )]
    #[serde(rename = "id")]
    pub id: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "fileId")]
    pub file_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "folderId")]
    pub folder_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "userId")]
    pub user_id: String,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "role")]
    pub role: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "sharedBy")]
    pub shared_by: String,
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
    name: "drive_shares",
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
    ],
    primary_key: None,
    indexes: &[
        Index {
            name: "drive_shares_file_user_idx",
            columns: &[
                IndexColumn {
                    expression: "file_id",
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
            name: "drive_shares_folder_user_idx",
            columns: &[
                IndexColumn {
                    expression: "folder_id",
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
            name: "drive_shares_user_idx",
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
            name: "drive_shares_file_id_files_id_fk",
            columns: &["file_id"],
            references: "files",
            referenced_columns: &["id"],
            on_delete: "cascade",
            on_update: "no action",
        },
        ForeignKey {
            name: "drive_shares_folder_id_folders_id_fk",
            columns: &["folder_id"],
            references: "folders",
            referenced_columns: &["id"],
            on_delete: "cascade",
            on_update: "no action",
        },
    ],
    uniques: &[],
    checks: &[Check {
        name: "drive_shares_one_item_check",
        expression: "num_nonnulls(\"drive_shares\".\"file_id\", \"drive_shares\".\"folder_id\") = 1",
    }],
};
