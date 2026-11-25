//! The permission lookups against a tenant database
//! (`createDrizzlePermissionQueries`).

use sea_orm::{ColumnTrait, DbErr, EntityTrait, QueryFilter, QuerySelect};
use serde_json::Value;
use sqlx::PgPool;
use weldsuite_permissions::{MemberRow, PermissionQueries, role_row_permissions};
use weldsuite_schema::tenant::{roles, workspace_members};

use crate::orm::orm;
use crate::workspaces::string_array;

/// [`PermissionQueries`] on one tenant's pool.
#[derive(Debug, Clone)]
pub struct TenantPermissionQueries {
    db: PgPool,
}

impl TenantPermissionQueries {
    pub fn new(db: PgPool) -> Self {
        Self { db }
    }
}

type MemberRecord = (
    String,
    String,
    Option<String>,
    Option<Value>,
    Option<Value>,
    Option<String>,
);

impl PermissionQueries for TenantPermissionQueries {
    type Error = DbErr;

    /// Only an ACTIVE member resolves: a suspended member loses access at
    /// once, and a pending invite grants nothing until it is accepted.
    async fn get_member(&self, user_id: &str) -> Result<Option<MemberRow>, DbErr> {
        let record: Option<MemberRecord> = workspace_members::Entity::find()
            .select_only()
            .columns([
                workspace_members::Column::Id,
                workspace_members::Column::Role,
                workspace_members::Column::RoleId,
                workspace_members::Column::Permissions,
                workspace_members::Column::PermissionDenies,
                workspace_members::Column::MemberType,
            ])
            .filter(workspace_members::Column::UserId.eq(user_id))
            .filter(workspace_members::Column::DeletedAt.is_null())
            .filter(workspace_members::Column::Status.eq("ACTIVE"))
            .limit(1)
            .into_tuple()
            .one(&orm(&self.db))
            .await?;
        Ok(record.map(
            |(id, role, role_id, permissions, permission_denies, member_type)| MemberRow {
                id,
                role,
                role_id,
                permissions: permissions.as_ref().map(|v| string_array(Some(v))),
                permission_denies: permission_denies.as_ref().map(|v| string_array(Some(v))),
                member_type,
            },
        ))
    }

    async fn get_role_permissions(&self, role_id: &str) -> Result<Option<Vec<String>>, DbErr> {
        let record: Option<(Option<Value>, bool, String)> = roles::Entity::find()
            .select_only()
            .columns([
                roles::Column::Permissions,
                roles::Column::IsSystem,
                roles::Column::Name,
            ])
            .filter(roles::Column::Id.eq(role_id))
            .filter(roles::Column::DeletedAt.is_null())
            .limit(1)
            .into_tuple()
            .one(&orm(&self.db))
            .await?;
        Ok(record.map(|(permissions, is_system, name)| {
            let stored = permissions.as_ref().map(|v| string_array(Some(v)));
            role_row_permissions(is_system, &name, stored.as_deref())
        }))
    }

    /// The tenant schema has no teams yet; the workers' adapter returns
    /// nothing either until it does.
    fn get_team_permissions(
        &self,
        _member_id: &str,
    ) -> impl Future<Output = Result<Vec<Vec<String>>, DbErr>> + Send {
        std::future::ready(Ok(Vec::new()))
    }
}
