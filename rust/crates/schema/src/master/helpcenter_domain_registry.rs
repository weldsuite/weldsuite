//! `helpcenter_domain_registry`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "helpcenter_domain_registry")]
pub struct Model {
    #[sea_orm(
        primary_key,
        auto_increment = false,
        column_type = "String(StringLen::N(30))"
    )]
    #[serde(rename = "id")]
    pub id: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "domain")]
    pub domain: String,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "domainType")]
    pub domain_type: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "workspaceId")]
    pub workspace_id: String,
    #[serde(rename = "isVerified")]
    pub is_verified: i32,
    #[serde(rename = "isActive")]
    pub is_active: i32,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "verificationToken")]
    pub verification_token: Option<String>,
    #[serde(rename = "verifiedAt", with = "crate::js::timestamp::option")]
    pub verified_at: Option<TimeDateTime>,
    #[serde(rename = "createdAt", with = "crate::js::timestamp")]
    pub created_at: TimeDateTime,
    #[serde(rename = "updatedAt", with = "crate::js::timestamp")]
    pub updated_at: TimeDateTime,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "helpcenter_domain_registry",
    columns: &[
        DdlColumn {
            name: "is_verified",
            sql_type: None,
            default: Some(DdlDefault::Number("1")),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "is_active",
            sql_type: None,
            default: Some(DdlDefault::Number("1")),
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
            name: "helpcenter_domain_registry_domain_idx",
            columns: &[IndexColumn {
                expression: "domain",
                is_expression: false,
                asc: true,
            }],
            unique: true,
            method: "btree",
            filter: None,
        },
        Index {
            name: "helpcenter_domain_registry_workspace_id_idx",
            columns: &[IndexColumn {
                expression: "workspace_id",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: None,
        },
    ],
    foreign_keys: &[ForeignKey {
        name: "helpcenter_domain_registry_workspace_id_workspaces_id_fk",
        columns: &["workspace_id"],
        references: "workspaces",
        referenced_columns: &["id"],
        on_delete: "cascade",
        on_update: "no action",
    }],
    uniques: &[Unique {
        name: "helpcenter_domain_registry_domain_unique",
        columns: &["domain"],
        nulls_not_distinct: false,
    }],
    checks: &[],
};
