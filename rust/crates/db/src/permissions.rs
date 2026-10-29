//! The permission lookups against a tenant database
//! (`createDrizzlePermissionQueries`).

use serde_json::Value;
use sqlx::PgPool;
use weldsuite_permissions::{MemberRow, PermissionQueries, role_row_permissions};

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

#[derive(sqlx::FromRow)]
struct MemberRecord {
    id: String,
    role: String,
    role_id: Option<String>,
    permissions: Option<Value>,
    permission_denies: Option<Value>,
    member_type: Option<String>,
}

#[derive(sqlx::FromRow)]
struct RoleRecord {
    permissions: Option<Value>,
    is_system: bool,
    name: String,
}

impl PermissionQueries for TenantPermissionQueries {
    type Error = sqlx::Error;

    /// Only an ACTIVE member resolves: a suspended member loses access at
    /// once, and a pending invite grants nothing until it is accepted.
    async fn get_member(&self, user_id: &str) -> Result<Option<MemberRow>, sqlx::Error> {
        let record: Option<MemberRecord> = sqlx::query_as(
            "select id, role, role_id, permissions, permission_denies, member_type
             from workspace_members
             where user_id = $1 and deleted_at is null and status = 'ACTIVE'
             limit 1",
        )
        .bind(user_id)
        .fetch_optional(&self.db)
        .await?;
        Ok(record.map(|record| MemberRow {
            id: record.id,
            role: record.role,
            role_id: record.role_id,
            permissions: record.permissions.as_ref().map(|v| string_array(Some(v))),
            permission_denies: record
                .permission_denies
                .as_ref()
                .map(|v| string_array(Some(v))),
            member_type: record.member_type,
        }))
    }

    async fn get_role_permissions(
        &self,
        role_id: &str,
    ) -> Result<Option<Vec<String>>, sqlx::Error> {
        let record: Option<RoleRecord> = sqlx::query_as(
            "select permissions, is_system, name from roles
             where id = $1 and deleted_at is null
             limit 1",
        )
        .bind(role_id)
        .fetch_optional(&self.db)
        .await?;
        Ok(record.map(|record| {
            let stored = record.permissions.as_ref().map(|v| string_array(Some(v)));
            role_row_permissions(record.is_system, &record.name, stored.as_deref())
        }))
    }

    /// The tenant schema has no teams yet; the workers' adapter returns
    /// nothing either until it does.
    fn get_team_permissions(
        &self,
        _member_id: &str,
    ) -> impl Future<Output = Result<Vec<Vec<String>>, sqlx::Error>> + Send {
        std::future::ready(Ok(Vec::new()))
    }
}
