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

use sea_orm::sea_query::extension::postgres::PgExpr;
use sea_orm::sea_query::{self, Expr, ExprTrait as _, Func, Order, Query};
use sea_orm::{
    ColumnTrait, ConnectionTrait, DbErr, EntityTrait, QueryFilter, QueryOrder, QuerySelect,
};
use serde_json::json;
use sqlx::PgPool;
use weldsuite_schema::tenant::workspace_settings;

use crate::orm::orm;

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
pub async fn sso_default_role(tenant: &PgPool) -> Result<&'static str, DbErr> {
    let stored: Option<Option<String>> = workspace_settings::Entity::find()
        .select_only()
        .column_as(
            PgExpr::cast_json_field(sso(), "defaultRole"),
            "default_role",
        )
        .filter(workspace_settings::Column::DeletedAt.is_null())
        .filter(sea_query::ExprTrait::is_not_null(sso()))
        .order_by_asc(workspace_settings::Column::CreatedAt)
        .order_by_asc(workspace_settings::Column::Id)
        .limit(1)
        .into_tuple()
        .one(&orm(tenant))
        .await?;
    Ok(sso_default_role_of(stored.flatten().as_deref()))
}

/// `custom_settings -> 'sso'`: SQL null when the settings have no `sso` key
/// (`custom_settings ? 'sso'` is false), as they are always an object.
fn sso() -> Expr {
    PgExpr::get_json_field(Expr::col(workspace_settings::Column::CustomSettings), "sso")
}

/// `case when jsonb_typeof(value) = 'object' then value else '{}' end`.
fn object_or_empty(value: Expr) -> Expr {
    Expr::case(
        sea_query::ExprTrait::eq(
            Expr::from(Func::cust("jsonb_typeof").arg(value.clone())),
            "object",
        ),
        value,
    )
    .finally(Expr::val(json!({})).cast_as("jsonb"))
    .into()
}

/// Sets the default role, merged into `custom_settings.sso` of the
/// workspace's settings row (created when there is none). `id` names a new
/// row. One statement each way, so a concurrent write of another settings
/// key is never overwritten.
///
/// # Errors
///
/// The tenant database's; a role outside [`SSO_DEFAULT_ROLES`] is stored as
/// [`SSO_DEFAULT_ROLE`].
pub async fn set_sso_default_role(tenant: &PgPool, role: &str, id: &str) -> Result<(), DbErr> {
    let role = sso_default_role_of(Some(role));
    let db = orm(tenant);
    let merged = Func::cust("jsonb_set")
        .arg(object_or_empty(Expr::col(
            workspace_settings::Column::CustomSettings,
        )))
        .arg(Expr::val("{sso}").cast_as("text[]"))
        .arg(PgExpr::concat(
            object_or_empty(sso()),
            Expr::val(json!({ "defaultRole": role })).cast_as("jsonb"),
        ))
        .arg(true);
    // The row the read above would pick, preferring one that has `sso`.
    let target = Query::select()
        .column(workspace_settings::Column::Id)
        .from(workspace_settings::Entity)
        .and_where(sea_query::ExprTrait::is_null(Expr::col(
            workspace_settings::Column::DeletedAt,
        )))
        .order_by_expr(sea_query::ExprTrait::is_not_null(sso()), Order::Desc)
        .order_by(workspace_settings::Column::CreatedAt, Order::Asc)
        .order_by(workspace_settings::Column::Id, Order::Asc)
        .limit(1)
        .to_owned();
    let updated = workspace_settings::Entity::update_many()
        .col_expr(
            workspace_settings::Column::CustomSettings,
            Expr::from(merged),
        )
        .col_expr(
            workspace_settings::Column::UpdatedAt,
            Expr::current_timestamp(),
        )
        .filter(workspace_settings::Column::Id.in_subquery(target))
        .exec(&db)
        .await?;
    if updated.rows_affected == 0 {
        let now = Expr::current_timestamp();
        let insert = Query::insert()
            .into_table(workspace_settings::Entity)
            .columns([
                workspace_settings::Column::Id,
                workspace_settings::Column::CustomSettings,
                workspace_settings::Column::CreatedAt,
                workspace_settings::Column::UpdatedAt,
            ])
            .values_panic([
                Expr::val(id),
                Expr::val(json!({ "sso": { "defaultRole": role } })).cast_as("jsonb"),
                now.clone(),
                now,
            ])
            .to_owned();
        db.execute(&insert).await?;
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
