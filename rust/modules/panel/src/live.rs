//! `GET /api/panel/live?projectId` (`routes/live/index.ts`): visitors with
//! activity in the last five minutes and the pages they are on, from the
//! project state (the `PanelProject` Durable Object on Global, a Valkey
//! sorted set per project here). `panel_reports:read`: it sits on the
//! Overview next to the traffic numbers.
//!
//! A live session names its visitor by the id the site gave it, which can be
//! a user id or an email, so without `panel_people:read` that id is replaced
//! by a stable pseudonym: the view still counts and groups, it just cannot
//! name anyone.

use axum::extract::{RawQuery, State};
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use weldsuite_catalogs::permission_keys::PANEL_PEOPLE_READ;
use weldsuite_kit::{ApiError, Data};
use weldsuite_permissions::Permissions;

use crate::people::PROJECT_QUERY;
use crate::project_state::ProjectRef;
use crate::projects::live_project;
use crate::{Caller, PanelState, unexpected};

/// The first 12 hex digits of `sha256("<project>:<distinct id>")`.
fn pseudonym(project_id: &str, distinct_id: &str) -> String {
    let digest = Sha256::digest(format!("{project_id}:{distinct_id}").as_bytes());
    hex::encode(digest)[..12].to_owned()
}

/// `GET /`.
pub(crate) async fn live(
    State(state): State<PanelState>,
    caller: Caller,
    permissions: Permissions,
    RawQuery(raw): RawQuery,
) -> Response {
    let parsed = match weldsuite_zod::query(&PROJECT_QUERY, raw.as_deref()) {
        Ok(parsed) => parsed,
        Err(response) => return response,
    };
    let project_id = parsed.text("projectId").unwrap_or_default().to_owned();
    match live_project(&caller, &project_id).await {
        Ok(Some(_)) => {}
        Ok(None) => return ApiError::not_found("Project", Some(&project_id)).into_response(),
        Err(error) => return unexpected(&error, "get project"),
    }
    let Some(project_state) = caller.project_state(&state) else {
        return ApiError::unavailable("The live view is not configured here").into_response();
    };
    let live = match project_state
        .live(ProjectRef {
            workspace_id: &caller.workspace_id,
            project_id: &project_id,
        })
        .await
    {
        Ok(live) => live,
        Err(error) => return unexpected(&error, "live view"),
    };
    let may_name = permissions.has_any(&[PANEL_PEOPLE_READ]);
    let sessions: Vec<Value> = live
        .sessions
        .iter()
        .map(|session| {
            let mut value = serde_json::to_value(session).unwrap_or(Value::Null);
            if !may_name {
                value["distinctId"] = json!(pseudonym(&project_id, &session.touch.distinct_id));
            }
            value
        })
        .collect();
    Data(json!({
        "projectId": project_id,
        "visitors": live.visitors,
        "sessions": sessions,
    }))
    .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pseudonyms_are_stable_and_short() {
        let first = pseudonym("pnp_a", "ada@example.com");
        assert_eq!(first, pseudonym("pnp_a", "ada@example.com"));
        assert_eq!(first.len(), 12);
        assert_ne!(first, pseudonym("pnp_b", "ada@example.com"));
    }
}
