//! `weldpass_vaults`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "weldpass_vaults")]
pub struct Model {
    #[sea_orm(
        primary_key,
        auto_increment = false,
        column_type = "String(StringLen::N(30))"
    )]
    #[serde(rename = "id")]
    pub id: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "workspaceId")]
    pub workspace_id: String,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "kind")]
    pub kind: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "ownerId")]
    pub owner_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(100))")]
    #[serde(rename = "name")]
    pub name: String,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "description")]
    pub description: Option<String>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "kekWrapped")]
    pub kek_wrapped: String,
    #[sea_orm(column_type = "String(StringLen::N(10))")]
    #[serde(rename = "rootKeyVersion")]
    pub root_key_version: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "createdBy")]
    pub created_by: Option<String>,
    #[serde(rename = "createdAt", with = "crate::js::timestamptz")]
    pub created_at: TimeDateTimeWithTimeZone,
    #[serde(rename = "updatedAt", with = "crate::js::timestamptz")]
    pub updated_at: TimeDateTimeWithTimeZone,
    #[serde(rename = "deletedAt", with = "crate::js::timestamptz::option")]
    pub deleted_at: Option<TimeDateTimeWithTimeZone>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "weldpass_vaults",
    columns: &[
        DdlColumn {
            name: "root_key_version",
            sql_type: None,
            default: Some(DdlDefault::Sql("'v1'")),
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
            name: "weldpass_vaults_workspace_idx",
            columns: &[IndexColumn {
                expression: "workspace_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "weldpass_vaults_personal_owner_idx",
            columns: &[
                IndexColumn {
                    expression: "workspace_id",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "owner_id",
                    is_expression: false,
                    asc: true,
                },
            ],
            unique: true,
            method: "btree",
            filter: Some(
                "\"weldpass_vaults\".\"kind\" = 'personal' AND \"weldpass_vaults\".\"deleted_at\" IS NULL",
            ),
        },
    ],
    foreign_keys: &[],
    uniques: &[],
    checks: &[],
};
