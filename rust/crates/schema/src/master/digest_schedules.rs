//! `digest_schedules`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "digest_schedules")]
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
    #[serde(rename = "enabled")]
    pub enabled: bool,
    #[serde(rename = "sendHour")]
    pub send_hour: i32,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "timezone")]
    pub timezone: String,
    #[serde(rename = "updatedAt", with = "crate::js::timestamptz")]
    pub updated_at: TimeDateTimeWithTimeZone,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "digest_schedules",
    columns: &[
        DdlColumn {
            name: "enabled",
            sql_type: None,
            default: Some(DdlDefault::Bool(true)),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "send_hour",
            sql_type: None,
            default: Some(DdlDefault::Number("8")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "timezone",
            sql_type: None,
            default: Some(DdlDefault::Sql("'UTC'")),
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
    indexes: &[Index {
        name: "digest_schedules_workspace_id_idx",
        columns: &[IndexColumn {
            expression: "workspace_id",
            is_expression: false,
            asc: true,
        }],
        unique: true,
        method: "btree",
        filter: None,
    }],
    foreign_keys: &[ForeignKey {
        name: "digest_schedules_workspace_id_workspaces_id_fk",
        columns: &["workspace_id"],
        references: "workspaces",
        referenced_columns: &["id"],
        on_delete: "cascade",
        on_update: "no action",
    }],
    uniques: &[],
    checks: &[],
};
