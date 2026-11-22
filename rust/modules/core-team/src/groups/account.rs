//! `/api/account` (`app-api/src/routes/account`): self-service account
//! deletion (Google Play / GDPR), behind the session only: a user with no
//! workspace must still be able to delete their account.
//!
//! - `GET /deletion-status`: what deleting would remove, what blocks it.
//! - `POST /delete`: refused (409) while the caller is the only admin of a
//!   workspace that still has other members; otherwise the organizations of
//!   the workspaces they are alone in are deleted at the identity provider,
//!   then the user, then the master rows are cleaned up directly (the
//!   provider's webhooks repeat it).
//!
//! Master database only; no entity events.

use axum::Router;
use axum::body::Bytes;
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use http::{HeaderMap, StatusCode};
use sea_orm::sea_query::{Expr, Func};
use sea_orm::{ColumnTrait, DbErr, EntityTrait, JoinType, QueryFilter, QuerySelect, RelationDef};
use serde_json::{Value, json};
use weldsuite_db::{PgPool, orm, utc_now};
use weldsuite_kit::Data;
use weldsuite_kit::validation::json_body;
use weldsuite_ports::with_identity;
use weldsuite_schema::master::enums::MembershipStatus;
use weldsuite_schema::master::{user_workspaces, users, workspaces};

use super::zod_issues::{ZodIssues, object};
use crate::{AccountCaller, CoreTeamState, TeamError, TeamResult, answer};

/// `DELETE_ACCOUNT_CONFIRMATION`: what the user types to confirm.
const CONFIRMATION: &str = "DELETE";

pub(crate) fn router() -> Router<CoreTeamState> {
    Router::new()
        .route("/deletion-status", get(deletion_status))
        .route("/delete", post(delete_account))
}

/// `AccountDeletionStatus`.
struct DeletionStatus {
    blockers: Vec<Value>,
    /// `(workspaceId, name)`.
    to_delete: Vec<(String, String)>,
}

impl DeletionStatus {
    fn json(&self) -> Value {
        json!({
            "canDelete": self.blockers.is_empty(),
            "blockers": self.blockers,
            "workspacesToDelete": self
                .to_delete
                .iter()
                .map(|(id, name)| json!({ "workspaceId": id, "name": name }))
                .collect::<Vec<_>>(),
        })
    }
}

/// `innerJoin(workspaces, eq(userWorkspaces.workspaceId, workspaces.id))`.
fn membership_workspace() -> RelationDef {
    user_workspaces::Entity::belongs_to(workspaces::Entity)
        .from(user_workspaces::Column::WorkspaceId)
        .to(workspaces::Column::Id)
        .into()
}

async fn compute_deletion_status(db: &PgPool, user_id: &str) -> Result<DeletionStatus, DbErr> {
    let db = orm(db);
    let memberships: Vec<(String, String, String)> = user_workspaces::Entity::find()
        .select_only()
        .columns([
            user_workspaces::Column::WorkspaceId,
            user_workspaces::Column::Role,
        ])
        .column(workspaces::Column::Name)
        .join(JoinType::InnerJoin, membership_workspace())
        .filter(user_workspaces::Column::UserId.eq(user_id))
        .filter(user_workspaces::Column::Status.eq(MembershipStatus::ACTIVE))
        .filter(workspaces::Column::IsActive.eq(true))
        .into_tuple()
        .all(&db)
        .await?;

    let mut blockers = Vec::new();
    let mut to_delete = Vec::new();
    if memberships.is_empty() {
        return Ok(DeletionStatus {
            blockers,
            to_delete,
        });
    }
    let ids: Vec<String> = memberships.iter().map(|m| m.0.clone()).collect();
    let others: Vec<(String, String)> = user_workspaces::Entity::find()
        .select_only()
        .columns([
            user_workspaces::Column::WorkspaceId,
            user_workspaces::Column::Role,
        ])
        .filter(user_workspaces::Column::WorkspaceId.is_in(ids))
        .filter(user_workspaces::Column::UserId.ne(user_id))
        .filter(user_workspaces::Column::Status.eq(MembershipStatus::ACTIVE))
        .into_tuple()
        .all(&db)
        .await?;

    for (workspace_id, role, name) in memberships {
        let other_roles: Vec<&str> = others
            .iter()
            .filter(|(id, _)| *id == workspace_id)
            .map(|(_, role)| role.as_str())
            .collect();
        if other_roles.is_empty() {
            to_delete.push((workspace_id, name));
            continue;
        }
        let other_admin = other_roles.contains(&"org:admin");
        if role == "org:admin" && !other_admin {
            blockers.push(json!({
                "workspaceId": workspace_id,
                "name": name,
                "reason": "sole_admin_with_members",
                "otherMemberCount": other_roles.len(),
            }));
        }
    }
    Ok(DeletionStatus {
        blockers,
        to_delete,
    })
}

async fn deletion_status(State(state): State<CoreTeamState>, caller: AccountCaller) -> Response {
    match compute_deletion_status(&caller.master(&state), &caller.user_id).await {
        Ok(status) => Data(status.json()).into_response(),
        Err(error) => {
            TeamError::internal("Failed to compute account deletion status", error).respond()
        }
    }
}

/// `deleteAccountInput`: `{ confirmation: z.literal('DELETE') }`.
fn read_confirmation(headers: &HeaderMap, body: &Bytes) -> TeamResult<()> {
    let content_type = headers
        .get(http::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok());
    let body = json_body(content_type, body)
        .map_err(|bad| TeamError::Response(Box::new(bad.into_response())))?;
    let mut issues = ZodIssues::default();
    if let Some(fields) = object(&mut issues, &body) {
        let value = fields.get("confirmation");
        if value.and_then(Value::as_str) != Some(CONFIRMATION) {
            // `received` is left out of the JSON when the field is missing.
            let mut issue = json!({
                "code": "invalid_literal",
                "expected": CONFIRMATION,
                "path": ["confirmation"],
                "message": format!("Invalid literal value, expected \"{CONFIRMATION}\""),
            });
            if let Some(value) = value {
                issue["received"] = value.clone();
            }
            issues.push(issue);
        }
    }
    issues.finish()
}

async fn delete_account(
    State(state): State<CoreTeamState>,
    caller: AccountCaller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(run_delete(&state, &caller, &headers, &body).await)
}

async fn run_delete(
    state: &CoreTeamState,
    caller: &AccountCaller,
    headers: &HeaderMap,
    body: &Bytes,
) -> TeamResult<Response> {
    read_confirmation(headers, body)?;
    let master = caller.master(state);
    let db = orm(&master);
    let failed =
        |error: &dyn std::fmt::Display| TeamError::internal("Failed to delete account", error);

    let status = compute_deletion_status(&master, &caller.user_id)
        .await
        .map_err(|e| failed(&e))?;
    if !status.blockers.is_empty() {
        let body = json!({
            "error": {
                "code": "CONFLICT",
                "message": "You are the only admin of a workspace that still has other members. Transfer ownership or remove the members before deleting your account.",
                "details": { "blockers": status.blockers },
            },
        });
        return Ok((StatusCode::CONFLICT, axum::Json(body)).into_response());
    }

    let identity = caller.identity(state);
    for (workspace_id, _) in &status.to_delete {
        let row: Option<Option<String>> = workspaces::Entity::find_by_id(workspace_id)
            .select_only()
            .column(workspaces::Column::ClerkOrgId)
            .into_tuple()
            .one(&db)
            .await
            .map_err(|e| failed(&e))?;
        let mut org_deleted = false;
        if let Some(org) = row.flatten() {
            match with_identity(identity.as_ref(), |i| i.delete_organization(&org)).await {
                Ok(()) => org_deleted = true,
                Err(error) => tracing::error!(
                    %error,
                    workspace_id,
                    "account: deleting the organization failed"
                ),
            }
        }
        let stamp = utc_now();
        let mut deactivate = workspaces::Entity::update_many()
            .col_expr(workspaces::Column::IsActive, Expr::value(false));
        if org_deleted {
            deactivate = deactivate.col_expr(
                workspaces::Column::DeletedAt,
                Func::coalesce([
                    Expr::col(workspaces::Column::DeletedAt),
                    Expr::value(stamp),
                ])
                .into(),
            );
        }
        deactivate
            .col_expr(workspaces::Column::UpdatedAt, Expr::value(stamp))
            .filter(workspaces::Column::Id.eq(workspace_id))
            .exec(&db)
            .await
            .map_err(|e| failed(&e))?;
    }

    // Removes credentials, sessions and the remaining memberships.
    with_identity(identity.as_ref(), |i| i.delete_user(&caller.user_id))
        .await
        .map_err(|e| failed(&e))?;

    let cleared = || Expr::value(Option::<String>::None);
    users::Entity::update_many()
        .col_expr(users::Column::IsActive, Expr::value(false))
        .col_expr(
            users::Column::Email,
            Expr::value(format!("{}@deleted.weldsuite.org", caller.user_id)),
        )
        .col_expr(users::Column::FirstName, cleared())
        .col_expr(users::Column::LastName, cleared())
        .col_expr(users::Column::ImageUrl, cleared())
        .col_expr(users::Column::Phone, cleared())
        .col_expr(users::Column::Nickname, cleared())
        .col_expr(users::Column::JobTitle, cleared())
        .col_expr(users::Column::Bio, cleared())
        .col_expr(users::Column::UpdatedAt, Expr::value(utc_now()))
        .filter(users::Column::Id.eq(&caller.user_id))
        .exec(&db)
        .await
        .map_err(|e| failed(&e))?;
    user_workspaces::Entity::delete_many()
        .filter(user_workspaces::Column::UserId.eq(&caller.user_id))
        .exec(&db)
        .await
        .map_err(|e| failed(&e))?;

    Ok(Data(json!({ "deleted": true })).into_response())
}
