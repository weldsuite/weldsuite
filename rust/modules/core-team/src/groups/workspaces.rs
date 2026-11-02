//! `/api/workspaces` (`app-api/src/routes/workspaces`, `listUserWorkspaces`
//! in `@weldsuite/core-domain/workspaces`): the workspaces the caller is an
//! active member of, for the workspace switcher. A master-DB read behind the
//! session and tenant layers, with no permission of its own; a failed read
//! answers an empty list.

use std::sync::Arc;

use axum::Router;
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use serde_json::{Value, json};
use weldsuite_kit::Data;
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::{Caller, CoreTeamState};

pub(crate) fn router<Q>(_gate: &Arc<PermissionGate<Q>>) -> Router<CoreTeamState>
where
    Q: PermissionQueries + 'static,
{
    Router::new().route("/", get(list))
}

type Row = (
    Option<String>,
    String,
    String,
    String,
    Option<String>,
    String,
);

async fn list(State(state): State<CoreTeamState>, caller: Caller) -> Response {
    let rows: Result<Vec<Row>, sqlx::Error> = sqlx::query_as(
        "select w.clerk_org_id, w.id, w.name, w.slug, w.image_url, uw.role
         from user_workspaces uw
         inner join workspaces w on uw.workspace_id = w.id
         where uw.user_id = $1 and uw.status = 'ACTIVE' and w.is_active = true",
    )
    .bind(&caller.user_id)
    .fetch_all(&caller.master(&state))
    .await;
    match rows {
        Ok(rows) => {
            let workspaces: Vec<Value> = rows
                .into_iter()
                .map(|(clerk_org_id, id, name, slug, image_url, role)| {
                    json!({
                        // Legacy rows without a Clerk org fall back to the id.
                        "id": clerk_org_id.unwrap_or_else(|| id.clone()),
                        "workspaceId": id,
                        "name": name,
                        "slug": slug,
                        "imageUrl": image_url,
                        "role": role,
                    })
                })
                .collect();
            Data(Value::Array(workspaces)).into_response()
        }
        Err(error) => {
            tracing::error!(%error, "workspaces: list failed");
            Data(json!([])).into_response()
        }
    }
}
