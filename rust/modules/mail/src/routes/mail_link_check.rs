//! `POST /api/mail-messages/{id}/link-check`: WeldMail's click-time link
//! protection, EU and self-hosted only (Global has no such route; the
//! platform hides the feature there, `mail-threat-protection`).
//!
//! The platform opens a link from a received message through its
//! `/weldmail/link` page, which asks this route first: a link a threat feed
//! lists is `malicious`, one a heuristic flags is `suspicious`, anything else
//! `safe` (`weldsuite_mail_domain::threats`). The check runs again at click
//! time because a link that was clean on delivery can be listed since.
//!
//! Only for a message the caller can read (`messages:read` and mailbox
//! access), so the route is no general URL oracle. Nothing is fetched from
//! the link itself, and nothing about it leaves the deployment.

use std::collections::BTreeMap;
use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use http::HeaderMap;
use weldsuite_catalogs::permission_keys::MESSAGES_READ;
use weldsuite_kit::Data;
use weldsuite_kit::validation::Presence;
use weldsuite_mail_domain::threats::{check_link, normalize_url, verdicts};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use super::mail_messages::locate_message;
use crate::util::{MailError, answer, validate};
use crate::{Caller, MailState};

/// The longest link accepted.
const MAX_URL: usize = 4096;
/// The anchor's visible text, accepted for later heuristics; unused today.
const MAX_TEXT: usize = 500;

pub(crate) fn routes<S, Q>(state: MailState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    Router::new()
        .route(
            "/mail-messages/{id}/link-check",
            post(link_check).route_layer(gate.require([MESSAGES_READ])),
        )
        .with_state(state)
}

/// Body `{ url, text? }` → `{ data: { url, verdict, reasons } }`.
async fn link_check(
    State(state): State<MailState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let result = async {
        let url = validate(&headers, &body, |issues, fields| {
            let url = issues.text(fields, "url", Presence::Required, Some(1), Some(MAX_URL));
            let _text = issues.text(fields, "text", Presence::Optional, None, Some(MAX_TEXT));
            url.into_option().unwrap_or_default()
        })?;
        locate_message(&caller, &id, "Message").await?;
        let finding = match &state.master {
            Some(master) => check_link(master, &url).await.map_err(|error| {
                tracing::error!(%error, "[mail-link-check] threat feed lookup failed");
                MailError::api(
                    weldsuite_kit::ApiError::internal().with_message("Failed to check the link"),
                )
            })?,
            // No master database (a test build): the heuristics alone.
            None => normalize_url(&url)
                .and_then(|u| verdicts(&[u], &BTreeMap::new()).into_iter().next()),
        };
        let Some(finding) = finding else {
            return Err(MailError::bad_request("url must be an http or https link"));
        };
        Ok(Data(finding.to_json()).into_response())
    }
    .await;
    answer(result, "Failed to check the link")
}
