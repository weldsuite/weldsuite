//! `weldpass_vault_events`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "weldpass_vault_events")]
pub struct Model {
    #[sea_orm(
        primary_key,
        auto_increment = false,
        column_type = "String(StringLen::N(30))"
    )]
    #[serde(rename = "id")]
    pub id: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "vaultId")]
    pub vault_id: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "itemId")]
    pub item_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "actorId")]
    pub actor_id: String,
    #[sea_orm(column_type = "String(StringLen::N(40))")]
    #[serde(rename = "action")]
    pub action: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "targetLabel")]
    pub target_label: Option<String>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "metadata")]
    pub metadata: Json,
    #[sea_orm(column_type = "String(StringLen::N(45))")]
    #[serde(rename = "ip")]
    pub ip: Option<String>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "userAgent")]
    pub user_agent: Option<String>,
    #[serde(rename = "createdAt", with = "crate::js::timestamptz")]
    pub created_at: TimeDateTimeWithTimeZone,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "weldpass_vault_events",
    columns: &[
        DdlColumn {
            name: "metadata",
            sql_type: None,
            default: Some(DdlDefault::Sql("'{}'::jsonb")),
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
    ],
    primary_key: None,
    indexes: &[
        Index {
            name: "weldpass_vault_events_vault_idx",
            columns: &[IndexColumn {
                expression: "vault_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "weldpass_vault_events_item_idx",
            columns: &[IndexColumn {
                expression: "item_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "weldpass_vault_events_created_at_idx",
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
    foreign_keys: &[],
    uniques: &[],
    checks: &[],
};
