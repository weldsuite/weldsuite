//! `user_app_oauth_clients`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "user_app_oauth_clients")]
pub struct Model {
    #[sea_orm(
        primary_key,
        auto_increment = false,
        column_type = "String(StringLen::N(30))"
    )]
    #[serde(rename = "id")]
    pub id: String,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "appId")]
    pub app_id: String,
    #[sea_orm(column_type = "String(StringLen::N(64))")]
    #[serde(rename = "clientId")]
    pub client_id: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "clientSecretHash")]
    pub client_secret_hash: String,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "redirectUris")]
    pub redirect_uris: Option<Json>,
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
    name: "user_app_oauth_clients",
    columns: &[
        DdlColumn {
            name: "redirect_uris",
            sql_type: None,
            default: Some(DdlDefault::Sql("'[]'::jsonb")),
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
    indexes: &[Index {
        name: "user_app_oauth_clients_app_id_idx",
        columns: &[IndexColumn {
            expression: "app_id",
            is_expression: false,
            asc: true,
        }],
        unique: false,
        method: "btree",
        filter: None,
    }],
    foreign_keys: &[ForeignKey {
        name: "user_app_oauth_clients_app_id_user_apps_id_fk",
        columns: &["app_id"],
        references: "user_apps",
        referenced_columns: &["id"],
        on_delete: "cascade",
        on_update: "no action",
    }],
    uniques: &[
        Unique {
            name: "user_app_oauth_clients_app_id_unique",
            columns: &["app_id"],
            nulls_not_distinct: false,
        },
        Unique {
            name: "user_app_oauth_clients_client_id_unique",
            columns: &["client_id"],
            nulls_not_distinct: false,
        },
    ],
    checks: &[],
};
