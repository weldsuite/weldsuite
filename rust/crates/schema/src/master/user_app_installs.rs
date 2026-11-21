//! `user_app_installs`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "user_app_installs")]
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
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "workspaceId")]
    pub workspace_id: String,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "status")]
    pub status: String,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "grantedScopes")]
    pub granted_scopes: Option<Json>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "pendingScopes")]
    pub pending_scopes: Option<Json>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "installedBy")]
    pub installed_by: String,
    #[serde(rename = "installedAt", with = "crate::js::timestamptz")]
    pub installed_at: TimeDateTimeWithTimeZone,
    #[serde(rename = "revokedAt", with = "crate::js::timestamptz::option")]
    pub revoked_at: Option<TimeDateTimeWithTimeZone>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "stripeSubscriptionId")]
    pub stripe_subscription_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(30))")]
    #[serde(rename = "subscriptionStatus")]
    pub subscription_status: Option<String>,
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
    name: "user_app_installs",
    columns: &[
        DdlColumn {
            name: "status",
            sql_type: None,
            default: Some(DdlDefault::Sql("'active'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "granted_scopes",
            sql_type: None,
            default: Some(DdlDefault::Sql("'[]'::jsonb")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "installed_at",
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
            name: "user_app_installs_app_workspace_idx",
            columns: &[
                IndexColumn {
                    expression: "app_id",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "workspace_id",
                    is_expression: false,
                    asc: true,
                },
            ],
            unique: true,
            method: "btree",
            filter: None,
        },
        Index {
            name: "user_app_installs_workspace_id_idx",
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
            name: "user_app_installs_app_id_idx",
            columns: &[IndexColumn {
                expression: "app_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
    ],
    foreign_keys: &[ForeignKey {
        name: "user_app_installs_app_id_user_apps_id_fk",
        columns: &["app_id"],
        references: "user_apps",
        referenced_columns: &["id"],
        on_delete: "cascade",
        on_update: "no action",
    }],
    uniques: &[],
    checks: &[],
};
