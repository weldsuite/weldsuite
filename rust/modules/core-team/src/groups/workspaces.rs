//! `/api/workspaces` (`app-api/src/routes/workspaces`, `listUserWorkspaces`
//! in `@weldsuite/core-domain/workspaces`): the workspaces the caller is an
//! active member of, for the workspace switcher. A master-DB read behind the
//! session and tenant layers, with no permission of its own. A failed read
//! answers 500, never an empty list: an empty list means the person belongs
//! to no workspace, and the platform's OIDC session takes it as such.
//!
//! In membership mode (`OIDC_WORKSPACE_SOURCE=header`) the token names no
//! workspace, so the list is what a client reads before it has picked one:
//! [`directory_router`] serves it behind the session only, and each entry's
//! `id` is `workspaces.id`, the value the client sends back in
//! `X-Weld-Workspace`. In claim mode `id` stays the organization id
//! (`clerk_org_id`), as the token's organization claim names it.

use std::sync::Arc;

use axum::Router;
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use sea_orm::{ColumnTrait, DbErr, EntityTrait, JoinType, QueryFilter, QuerySelect, RelationDef};
use serde_json::{Value, json};
use weldsuite_db::{PgPool, orm};
use weldsuite_kit::{ApiError, Data};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::master::enums::MembershipStatus;
use weldsuite_schema::master::{user_workspaces, workspaces};

use crate::{AccountCaller, Caller, CoreTeamState};

pub(crate) fn router<Q>(_gate: &Arc<PermissionGate<Q>>) -> Router<CoreTeamState>
where
    Q: PermissionQueries + 'static,
{
    Router::new().route("/", get(list))
}

/// The membership-mode list, behind the session only.
pub(crate) fn directory_router() -> Router<CoreTeamState> {
    Router::new().route("/", get(directory))
}

/// What an entry's `id` is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum EntryId {
    /// The organization id (`clerk_org_id`), else `workspaces.id`.
    Organization,
    /// `workspaces.id`, what `X-Weld-Workspace` takes.
    Workspace,
}

type Row = (
    Option<String>,
    String,
    String,
    String,
    Option<String>,
    String,
);

/// One entry of the list.
pub(crate) fn entry(row: Row, ids: EntryId) -> Value {
    let (clerk_org_id, id, name, slug, image_url, role) = row;
    let entry_id = match ids {
        // Legacy rows without a Clerk org fall back to the id.
        EntryId::Organization => clerk_org_id.unwrap_or_else(|| id.clone()),
        EntryId::Workspace => id.clone(),
    };
    json!({
        "id": entry_id,
        "workspaceId": id,
        "name": name,
        "slug": slug,
        "imageUrl": image_url,
        "role": role,
    })
}

/// `innerJoin(workspaces, eq(userWorkspaces.workspaceId, workspaces.id))`.
fn membership_workspace() -> RelationDef {
    user_workspaces::Entity::belongs_to(workspaces::Entity)
        .from(user_workspaces::Column::WorkspaceId)
        .to(workspaces::Column::Id)
        .into()
}

/// The caller's active memberships of active workspaces.
async fn rows(master: &PgPool, user_id: &str) -> Result<Vec<Row>, DbErr> {
    user_workspaces::Entity::find()
        .select_only()
        .column(workspaces::Column::ClerkOrgId)
        .column(workspaces::Column::Id)
        .column(workspaces::Column::Name)
        .column(workspaces::Column::Slug)
        .column(workspaces::Column::ImageUrl)
        .column(user_workspaces::Column::Role)
        .join(JoinType::InnerJoin, membership_workspace())
        .filter(user_workspaces::Column::UserId.eq(user_id))
        .filter(user_workspaces::Column::Status.eq(MembershipStatus::ACTIVE))
        .filter(workspaces::Column::IsActive.eq(true))
        .into_tuple()
        .all(&orm(master))
        .await
}

async fn answer(master: &PgPool, user_id: &str, ids: EntryId) -> Response {
    let rows = rows(master, user_id).await;
    match rows {
        Ok(rows) => {
            let workspaces: Vec<Value> = rows.into_iter().map(|row| entry(row, ids)).collect();
            Data(Value::Array(workspaces)).into_response()
        }
        Err(error) => {
            tracing::error!(%error, "workspaces: list failed");
            ApiError::internal()
                .with_message("Failed to list workspaces")
                .into_response()
        }
    }
}

async fn list(State(state): State<CoreTeamState>, caller: Caller) -> Response {
    answer(
        &caller.master(&state),
        &caller.user_id,
        EntryId::Organization,
    )
    .await
}

async fn directory(State(state): State<CoreTeamState>, caller: AccountCaller) -> Response {
    answer(&caller.master(&state), &caller.user_id, EntryId::Workspace).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(clerk_org_id: Option<&str>) -> Row {
        (
            clerk_org_id.map(str::to_owned),
            "ws_1".to_owned(),
            "Acme".to_owned(),
            "acme".to_owned(),
            None,
            "org:admin".to_owned(),
        )
    }

    #[test]
    fn claim_mode_names_the_organization_and_membership_mode_the_workspace() {
        let claim = entry(row(Some("org_1")), EntryId::Organization);
        assert_eq!(
            claim,
            json!({
                "id": "org_1", "workspaceId": "ws_1", "name": "Acme", "slug": "acme",
                "imageUrl": null, "role": "org:admin",
            })
        );
        assert_eq!(entry(row(None), EntryId::Organization)["id"], "ws_1");
        let header = entry(row(Some("org_1")), EntryId::Workspace);
        assert_eq!(header["id"], "ws_1");
        assert_eq!(header["workspaceId"], "ws_1");
    }
}
