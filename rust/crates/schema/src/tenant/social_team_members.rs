//! `social_team_members`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "social_team_members")]
pub struct Model {
    #[sea_orm(
        primary_key,
        auto_increment = false,
        column_type = "String(StringLen::N(30))"
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
    #[serde(rename = "userId")]
    pub user_id: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "email")]
    pub email: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "name")]
    pub name: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(500))")]
    #[serde(rename = "avatarUrl")]
    pub avatar_url: Option<String>,
    #[serde(rename = "role")]
    pub role: super::enums::SocialTeamRole,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "permissions")]
    pub permissions: Option<Json>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "accountAccess")]
    pub account_access: Option<Json>,
    #[serde(rename = "canAccessAllAccounts")]
    pub can_access_all_accounts: Option<bool>,
    #[serde(rename = "isActive")]
    pub is_active: bool,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "invitedByUserId")]
    pub invited_by_user_id: Option<String>,
    #[serde(rename = "invitedAt", with = "crate::js::timestamp::option")]
    pub invited_at: Option<TimeDateTime>,
    #[serde(rename = "acceptedAt", with = "crate::js::timestamp::option")]
    pub accepted_at: Option<TimeDateTime>,
    #[serde(rename = "lastActiveAt", with = "crate::js::timestamp::option")]
    pub last_active_at: Option<TimeDateTime>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "notificationPreferences")]
    pub notification_preferences: Option<Json>,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "metadata")]
    pub metadata: Option<Json>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "social_team_members",
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
            name: "role",
            sql_type: None,
            default: Some(DdlDefault::Sql("'contributor'")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "can_access_all_accounts",
            sql_type: None,
            default: Some(DdlDefault::Bool(false)),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "is_active",
            sql_type: None,
            default: Some(DdlDefault::Bool(true)),
            generated: None,
            default_fn: false,
            on_update: false,
        },
    ],
    primary_key: None,
    indexes: &[
        Index {
            name: "social_team_members_user_idx",
            columns: &[IndexColumn {
                expression: "user_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "social_team_members_role_idx",
            columns: &[IndexColumn {
                expression: "role",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
        Index {
            name: "social_team_members_is_active_idx",
            columns: &[IndexColumn {
                expression: "is_active",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
    ],
    foreign_keys: &[],
    uniques: &[Unique {
        name: "social_team_members_unique",
        columns: &["user_id"],
        nulls_not_distinct: false,
    }],
    checks: &[],
};
