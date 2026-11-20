//! The role a person gets when they join a workspace through its SSO
//! connection (ADR SEC-019 phase 5a, WeldID mode): a workspace setting,
//! kept in WeldSuite's own data rather than at the identity provider.
//!
//! It lives in the tenant database's `workspace_settings.custom_settings`
//! under `sso.defaultRole`, next to the other module settings kept there
//! (`parcel`, `printnode`, `social`), so it needs no table or column of its
//! own. `/api/sso` writes it (`weldsuite-core-platform`); the identity sync
//! reads it when WeldID reports a first SSO sign-in
//! (`weldsuite-core-onboarding`).
//!
//! Only `ADMIN`, `MEMBER` and `VIEWER` are offered: nobody becomes an owner
//! by signing in. Anything else stored reads as [`SSO_DEFAULT_ROLE`].

use sqlx::PgPool;

/// The roles an SSO member may get.
pub const SSO_DEFAULT_ROLES: [&str; 3] = ["ADMIN", "MEMBER", "VIEWER"];

/// The role when none is set.
pub const SSO_DEFAULT_ROLE: &str = "MEMBER";

/// `role` if it is one an SSO member may get.
pub fn sso_default_role_of(role: Option<&str>) -> &'static str {
    role.and_then(|role| {
        SSO_DEFAULT_ROLES
            .iter()
            .copied()
            .find(|allowed| *allowed == role)
    })
    .unwrap_or(SSO_DEFAULT_ROLE)
}

/// The workspace's default role for SSO members.
///
/// # Errors
///
/// The tenant database's.
pub async fn sso_default_role(tenant: &PgPool) -> Result<&'static str, sqlx::Error> {
    let stored: Option<Option<String>> = sqlx::query_scalar(
        "select custom_settings -> 'sso' ->> 'defaultRole' from workspace_settings
          where deleted_at is null and custom_settings ? 'sso'
          order by created_at, id limit 1",
    )
    .fetch_optional(tenant)
    .await?;
    Ok(sso_default_role_of(stored.flatten().as_deref()))
}

/// Sets the default role, merged into `custom_settings.sso` of the
/// workspace's settings row (created when there is none). `id` names a new
/// row.
///
/// # Errors
///
/// The tenant database's; a role outside [`SSO_DEFAULT_ROLES`] is stored as
/// [`SSO_DEFAULT_ROLE`].
pub async fn set_sso_default_role(
    tenant: &PgPool,
    role: &str,
    id: &str,
) -> Result<(), sqlx::Error> {
    let role = sso_default_role_of(Some(role));
    let updated: Option<String> = sqlx::query_scalar(
        "update workspace_settings w
            set custom_settings = jsonb_set(
                  case when jsonb_typeof(w.custom_settings) = 'object'
                       then w.custom_settings else '{}'::jsonb end,
                  '{sso}',
                  case when jsonb_typeof(w.custom_settings -> 'sso') = 'object'
                       then w.custom_settings -> 'sso' else '{}'::jsonb end
                    || jsonb_build_object('defaultRole', $1::text),
                  true),
                updated_at = now()
          where w.id = (select id from workspace_settings
                         where deleted_at is null
                         order by (custom_settings ? 'sso') desc, created_at, id
                         limit 1)
          returning w.id",
    )
    .bind(role)
    .fetch_optional(tenant)
    .await?;
    if updated.is_none() {
        sqlx::query(
            "insert into workspace_settings (id, custom_settings, created_at, updated_at)
             values ($1, jsonb_build_object('sso', jsonb_build_object('defaultRole', $2::text)),
                     now(), now())",
        )
        .bind(id)
        .bind(role)
        .execute(tenant)
        .await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_offered_roles_are_kept() {
        assert_eq!(sso_default_role_of(Some("ADMIN")), "ADMIN");
        assert_eq!(sso_default_role_of(Some("VIEWER")), "VIEWER");
        assert_eq!(sso_default_role_of(Some("OWNER")), "MEMBER");
        assert_eq!(sso_default_role_of(Some("admin")), "MEMBER");
        assert_eq!(sso_default_role_of(None), "MEMBER");
    }
}
