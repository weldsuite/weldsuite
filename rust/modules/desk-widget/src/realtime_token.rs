//! `routes/realtime.ts`: `POST /api/realtime/token`, a short-lived HS256
//! token for the visitor's conversation room socket, minted only for a
//! conversation the visitor may open (the visitor of the visitor token,
//! [`crate::visitor_auth`]). The realtime gateway refuses a token that is
//! not bound to the room it joins. Typing indicators travel over that
//! socket, not through this API.

use axum::Extension;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde_json::{Map, Value, json};
use time::OffsetDateTime;
use weldsuite_desk_domain::webchat;
use weldsuite_kit::validation::{Issues, Presence, Text, json_body};

use crate::auth::Widget;
use crate::live::visitor_display_name;
use crate::tokens::sign_jwt;
use crate::visitor_auth::Visitor;
use crate::{Ctx, WidgetState, internal, not_found_error, success, uncaught};

/// How long a token is good for, in seconds.
const TOKEN_TTL_SECONDS: i64 = 3600;

/// `POST /api/realtime/token`.
pub(crate) async fn token(
    State(state): State<WidgetState>,
    ctx: Ctx,
    Extension(widget): Extension<Widget>,
    Extension(caller): Extension<Visitor>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let content_type = headers
        .get(http::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok());
    let Ok(body) = json_body(content_type, &body) else {
        return uncaught(&ctx, &state, "Malformed JSON in request body");
    };
    let mut issues = Issues::default();
    let read = issues.object(&body).map(|fields: &Map<String, Value>| {
        issues_text(
            &mut issues,
            fields,
            "conversationId",
            Text::length(Some(1), Some(64)),
        )
    });
    if let Err(invalid) = issues.finish() {
        return invalid.into_response();
    }
    let Some(Some(conversation_id)) = read else {
        return internal("Internal server error");
    };
    let visitor_id = caller.id().to_owned();
    let Some(secret) = ctx.token_secret(&state).filter(|secret| !secret.is_empty()) else {
        return internal("WIDGET_TOKEN_SECRET not configured");
    };
    let conversation = match webchat::get(&widget.db, &conversation_id, false).await {
        Ok(Some((conversation, _))) => conversation,
        Ok(None) => return not_found_error("Conversation", &conversation_id),
        Err(error) => return uncaught(&ctx, &state, &error.to_string()),
    };
    match webchat::can_access(&widget.db, &conversation, &caller.principal).await {
        Ok(true) => {}
        Ok(false) => return not_found_error("Conversation", &conversation_id),
        Err(error) => return uncaught(&ctx, &state, &error.to_string()),
    }
    let visitor_name = visitor_display_name(&widget.db, &visitor_id, &conversation).await;
    let now = OffsetDateTime::now_utc().unix_timestamp();
    let token = sign_jwt(
        &secret,
        &[
            ("sub", json!(visitor_id)),
            ("customerId", json!(visitor_id)),
            ("customerName", json!(visitor_name)),
            ("workspaceId", json!(widget.clerk_org_id)),
            ("widgetId", json!(widget.id)),
            ("conversationId", json!(conversation_id)),
            ("iat", json!(now)),
            ("exp", json!(now + TOKEN_TTL_SECONDS)),
        ],
    );
    success(
        StatusCode::OK,
        json!({ "token": token, "expiresIn": TOKEN_TTL_SECONDS }),
    )
}

fn issues_text(
    issues: &mut Issues,
    fields: &Map<String, Value>,
    key: &str,
    rules: Text,
) -> Option<String> {
    issues
        .text_with(fields, key, Presence::Required, rules)
        .into_option()
}
