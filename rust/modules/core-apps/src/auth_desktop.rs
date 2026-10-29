//! The desktop shell's sign-in handoff, `/api/auth-desktop/ticket`
//! (`routes/auth-desktop/index.ts`): a two-minute, single-use sign-in token
//! from the identity provider, so the shell (opened at
//! `weldsuite://auth?ticket=…`) signs in without asking for credentials
//! again. Behind the session only: no workspace needs to be chosen yet.

use axum::Router;
use axum::body::Bytes;
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use http::HeaderMap;
use serde_json::json;
use weldsuite_kit::{ApiError, Data};

use crate::CoreAppsState;
use crate::access::{AppsError, SignedIn, answer, now_ms, validate};
use crate::schemas;

/// Only these schemes may receive a ticket (no exfiltration to the web).
const ALLOWED_RETURN_SCHEMES: [&str; 1] = ["weldsuite"];
const TICKET_TTL_SECONDS: u32 = 120;

pub(crate) fn router() -> Router<CoreAppsState> {
    Router::new().route("/ticket", post(ticket))
}

async fn ticket(State(state): State<CoreAppsState>, caller: SignedIn, headers: HeaderMap, body: Bytes) -> Response {
    answer(
        async {
            let requested = validate(&headers, &body, schemas::desktop_ticket)?;
            if caller.user_id.is_empty() {
                return Err(ApiError::unauthorized().with_message("No user").into());
            }
            let return_to = requested.unwrap_or_else(|| "weldsuite://auth".to_owned());
            match url::Url::parse(&return_to) {
                Ok(url) if ALLOWED_RETURN_SCHEMES.contains(&url.scheme()) => {}
                Ok(_) => return Err(ApiError::bad_request("return_to scheme not allowed").into()),
                Err(_) => return Err(ApiError::bad_request("return_to is not a valid URL").into()),
            }
            let identity = caller.overrides.identity(&state);
            let token = match identity {
                Some(identity) => identity
                    .create_sign_in_token(&caller.user_id, TICKET_TTL_SECONDS)
                    .await
                    .map_err(|error| error.to_string()),
                None => Err("no identity provider is configured".to_owned()),
            };
            let token = token.map_err(|error| {
                AppsError::internal("Could not create desktop sign-in ticket", error)
            })?;
            Ok(Data(json!({
                "ticket": token,
                "expiresAt": now_ms() + i64::from(TICKET_TTL_SECONDS) * 1000,
                "returnTo": return_to,
            }))
            .into_response())
        }
        .await,
    )
}
