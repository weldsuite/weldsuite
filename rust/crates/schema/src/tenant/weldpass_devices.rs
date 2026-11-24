//! `weldpass_devices`: the phones (and other clients) that keep an encrypted
//! offline copy of their owner's vaults (ADR PASS-010). A device is revoked,
//! never deleted: its next sync tells it to wipe the copy.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "weldpass_devices")]
pub struct Model {
    #[sea_orm(
        primary_key,
        auto_increment = false,
        column_type = "String(StringLen::N(30))"
    )]
    #[serde(rename = "id")]
    pub id: String,
    /// The Clerk org id, as the other `weldpass_*` tables hold it.
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "workspaceId")]
    pub workspace_id: String,
    /// Its owner: only they sync it.
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "userId")]
    pub user_id: String,
    #[sea_orm(column_type = "String(StringLen::N(100))")]
    #[serde(rename = "name")]
    pub name: String,
    /// `ios`, `android` or `other`.
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "platform")]
    pub platform: String,
    #[sea_orm(column_type = "String(StringLen::N(40))")]
    #[serde(rename = "appVersion")]
    pub app_version: Option<String>,
    #[serde(rename = "createdAt", with = "crate::js::timestamptz")]
    pub created_at: TimeDateTimeWithTimeZone,
    #[serde(rename = "lastSyncAt", with = "crate::js::timestamptz::option")]
    pub last_sync_at: Option<TimeDateTimeWithTimeZone>,
    #[serde(rename = "revokedAt", with = "crate::js::timestamptz::option")]
    pub revoked_at: Option<TimeDateTimeWithTimeZone>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "revokedBy")]
    pub revoked_by: Option<String>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "weldpass_devices",
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
            name: "weldpass_devices_workspace_user_idx",
            columns: &[
                IndexColumn {
                    expression: "workspace_id",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "user_id",
                    is_expression: false,
                    asc: true,
                },
            ],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "weldpass_devices_workspace_created_at_idx",
            columns: &[
                IndexColumn {
                    expression: "workspace_id",
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
    ],
    foreign_keys: &[],
    uniques: &[],
    checks: &[],
};
