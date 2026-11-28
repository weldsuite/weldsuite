//! `forms_custom_domains`: a workspace's own host names for its WeldForms links (`forms.acme.com/f/<publicId>`), checked and routed from the master database alone so the forms portal and the sweep never open a tenant database. EU and self-hosted only.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "forms_custom_domains")]
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
    #[sea_orm(column_type = "String(StringLen::N(253))")]
    #[serde(rename = "hostname")]
    pub hostname: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "workspaceId")]
    pub workspace_id: String,
    #[serde(rename = "isPrimary")]
    pub is_primary: bool,
    #[sea_orm(column_type = "String(StringLen::N(12))")]
    #[serde(rename = "status")]
    pub status: String,
    #[sea_orm(column_type = "String(StringLen::N(12))")]
    #[serde(rename = "sslStatus")]
    pub ssl_status: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(64))")]
    #[serde(rename = "verificationToken")]
    pub verification_token: String,
    #[sea_orm(column_type = "Text")]
    #[serde(rename = "lastError")]
    pub last_error: Option<String>,
    #[serde(rename = "lastCheckedAt", with = "crate::js::timestamp::option")]
    pub last_checked_at: Option<TimeDateTime>,
    #[serde(rename = "verifiedAt", with = "crate::js::timestamp::option")]
    pub verified_at: Option<TimeDateTime>,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "homeFormPublicId")]
    pub home_form_public_id: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "createdByUserId")]
    pub created_by_user_id: Option<String>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "forms_custom_domains",
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
            name: "is_primary",
            sql_type: None,
            default: Some(DdlDefault::Bool(false)),
            generated: None,
            default_fn: false,
            on_update: false,
        },
        DdlColumn {
            name: "status",
            sql_type: None,
            default: Some(DdlDefault::Sql("'pending'")),
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
            name: "forms_custom_domains_hostname_uidx",
            columns: &[IndexColumn {
                expression: "hostname",
                is_expression: false,
                asc: true,
            }],
            unique: true,
            method: "btree",
            filter: None,
        },
        Index {
            name: "forms_custom_domains_workspace_idx",
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
            name: "forms_custom_domains_pending_idx",
            columns: &[IndexColumn {
                expression: "status",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: Some("\"forms_custom_domains\".\"status\" <> 'active'"),
        },
    ],
    foreign_keys: &[],
    uniques: &[],
    checks: &[],
};
