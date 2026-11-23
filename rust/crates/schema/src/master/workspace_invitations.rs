//! `workspace_invitations`.

use sea_orm::entity::prelude::*;

#[allow(unused_imports)]
use crate::ddl::{
    Check, Column as DdlColumn, Default as DdlDefault, ForeignKey, Index, IndexColumn,
    PrimaryKey as DdlPrimaryKey, Table, Unique,
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, serde::Serialize)]
#[sea_orm(table_name = "workspace_invitations")]
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
    #[sea_orm(column_type = "String(StringLen::N(320))")]
    #[serde(rename = "email")]
    pub email: String,
    #[sea_orm(column_type = "String(StringLen::N(320))")]
    #[serde(rename = "emailNormalized")]
    pub email_normalized: String,
    #[sea_orm(column_type = "String(StringLen::N(50))")]
    #[serde(rename = "role")]
    pub role: String,
    #[sea_orm(column_type = "JsonBinary")]
    #[serde(rename = "publicMetadata")]
    pub public_metadata: Json,
    #[sea_orm(column_type = "String(StringLen::N(20))")]
    #[serde(rename = "status")]
    pub status: String,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "invitedBy")]
    pub invited_by: Option<String>,
    #[sea_orm(column_type = "String(StringLen::N(255))")]
    #[serde(rename = "acceptedBy")]
    pub accepted_by: Option<String>,
    #[serde(rename = "createdAt", with = "crate::js::timestamptz")]
    pub created_at: TimeDateTimeWithTimeZone,
    #[serde(rename = "expiresAt", with = "crate::js::timestamptz")]
    pub expires_at: TimeDateTimeWithTimeZone,
    #[serde(rename = "acceptedAt", with = "crate::js::timestamptz::option")]
    pub accepted_at: Option<TimeDateTimeWithTimeZone>,
    #[serde(rename = "revokedAt", with = "crate::js::timestamptz::option")]
    pub revoked_at: Option<TimeDateTimeWithTimeZone>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

/// What the entity doesn't say about the table: defaults, indexes, constraints.
pub const DDL: Table = Table {
    name: "workspace_invitations",
    columns: &[
        DdlColumn {
            name: "public_metadata",
            sql_type: None,
            default: Some(DdlDefault::Sql("'{}'::jsonb")),
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
            name: "workspace_invitations_pending_email_uidx",
            columns: &[
                IndexColumn {
                    expression: "workspace_id",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "email_normalized",
                    is_expression: false,
                    asc: true,
                },
            ],
            unique: true,
            method: "btree",
            filter: Some("\"workspace_invitations\".\"status\" = 'pending'"),
        },
        Index {
            name: "workspace_invitations_workspace_status_idx",
            columns: &[
                IndexColumn {
                    expression: "workspace_id",
                    is_expression: false,
                    asc: true,
                },
                IndexColumn {
                    expression: "status",
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
        Index {
            name: "workspace_invitations_pending_email_idx",
            columns: &[IndexColumn {
                expression: "email_normalized",
                is_expression: false,
                asc: true,
            }],
            unique: false,
            method: "btree",
            filter: Some("\"workspace_invitations\".\"status\" = 'pending'"),
        },
    ],
    foreign_keys: &[
        ForeignKey {
            name: "workspace_invitations_workspace_id_workspaces_id_fk",
            columns: &["workspace_id"],
            references: "workspaces",
            referenced_columns: &["id"],
            on_delete: "cascade",
            on_update: "no action",
        },
        ForeignKey {
            name: "workspace_invitations_invited_by_users_id_fk",
            columns: &["invited_by"],
            references: "users",
            referenced_columns: &["id"],
            on_delete: "set null",
            on_update: "no action",
        },
        ForeignKey {
            name: "workspace_invitations_accepted_by_users_id_fk",
            columns: &["accepted_by"],
            references: "users",
            referenced_columns: &["id"],
            on_delete: "set null",
            on_update: "no action",
        },
    ],
    uniques: &[],
    checks: &[Check {
        name: "workspace_invitations_status_check",
        expression: "\"workspace_invitations\".\"status\" in ('pending', 'accepted', 'revoked')",
    }],
};
