//! `merge_provider_accounts`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "merge_provider_accounts")]
pub struct Model {
    #[sea_orm(
        primary_key,
        auto_increment = false,
        column_type = "String(StringLen::N(30))"
    )]
    #[serde(rename = "id")]
    pub id: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "userId")]
    pub user_id: String,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "provider")]
    pub provider: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "login")]
    pub login: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "externalUserId")]
    pub external_user_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(500))")]
    #[serde(rename = "host")]
    pub host: Option<String>,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "credentials")]
    pub credentials: Option<String>,
    #[serde(
        rename = "credentialsExpireAt",
        with = "crate::js::timestamptz::option"
    )]
    pub credentials_expire_at: Option<TimeDateTimeWithTimeZone>,
    #[serde(rename = "verifiedAt", with = "crate::js::timestamptz::option")]
    pub verified_at: Option<TimeDateTimeWithTimeZone>,
    #[sea_orm(column_type = "String(StringLen::N(1000))")]
    #[serde(rename = "avatarUrl")]
    pub avatar_url: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "displayName")]
    pub display_name: Option<String>,
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
    name: "merge_provider_accounts",
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
            name: "merge_provider_accounts_login_idx",
            columns: &[
                IndexColumn {
                    expression: "provider",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "coalesce(\"host\", '')",
                    is_expression: true,
                    asc: true,
                },
                IndexColumn {
                    expression: "login",
                    is_expression: false,
                    asc: true,
                },
            ],
            unique: true,
            method: "btree",
            filter: None,
        },
        Index {
            name: "merge_provider_accounts_user_idx",
            columns: &[
                IndexColumn {
                    expression: "user_id",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "provider",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "coalesce(\"host\", '')",
                    is_expression: true,
                    asc: true,
                },
            ],
            unique: true,
            method: "btree",
            filter: None,
        },
    ],
    foreign_keys: &[],
    uniques: &[],
    checks: &[],
};
