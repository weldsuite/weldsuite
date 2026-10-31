//! `routes/realtime.ts`: `POST /api/realtime/token`, a short-lived HS256
//! token for the visitor's conversation room socket, minted only for the
//! visitor who owns the conversation. The realtime gateway refuses a token
//! that is not bound to the room it joins. Typing indicators travel over
//! that socket, not through this API.

use axum::Extension;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::{Hmac, KeyInit, Mac};
use serde_json::{Map, Value, json};
use sha2::Sha256;
use time::OffsetDateTime;
use weldsuite_desk_domain::webchat;
use weldsuite_kit::validation::{Issues, Presence, Text, json_body};

use crate::auth::Widget;
use crate::live::visitor_display_name;
use crate::{Ctx, WidgetState, internal, not_found_error, success, uncaught};

/// How long a token is good for, in seconds.
const TOKEN_TTL_SECONDS: i64 = 3600;

/// `signToken(secret, payload)`: a JWT, HS256, its parts base64url without
/// padding and the payload's keys in the order given.
pub(crate) fn sign_token(secret: &str, payload: &[(&str, Value)]) -> String {
    let header = URL_SAFE_NO_PAD.encode(r#"{"alg":"HS256","typ":"JWT"}"#);
    // `JSON.stringify` of an object literal keeps its keys in order;
    // `serde_json`'s map would sort them.
    let fields: Vec<String> = payload
        .iter()
        .map(|(key, value)| format!("{}:{value}", Value::String((*key).to_owned())))
        .collect();
    let body = URL_SAFE_NO_PAD.encode(format!("{{{}}}", fields.join(",")));
    let signing_input = format!("{header}.{body}");
    // HMAC takes keys of any length; `new_from_slice` cannot fail for it.
    let signature = <Hmac<Sha256> as KeyInit>::new_from_slice(secret.as_bytes())
        .map(|mut mac| {
            mac.update(signing_input.as_bytes());
            mac.finalize().into_bytes().to_vec()
        })
        .unwrap_or_default();
    format!("{signing_input}.{}", URL_SAFE_NO_PAD.encode(signature))
}

/// `POST /api/realtime/token`.
pub(crate) async fn token(
    State(state): State<WidgetState>,
    ctx: Ctx,
    Extension(widget): Extension<Widget>,
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
        let rules = Text::length(Some(1), Some(64));
        (
            issues_text(&mut issues, fields, "visitorId", rules),
            issues_text(&mut issues, fields, "conversationId", rules),
        )
    });
    if let Err(invalid) = issues.finish() {
        return invalid.into_response();
    }
    let Some((Some(visitor_id), Some(conversation_id))) = read else {
        return internal("Internal server error");
    };
    let Some(secret) = ctx.token_secret(&state).filter(|secret| !secret.is_empty()) else {
        return internal("WIDGET_TOKEN_SECRET not configured");
    };
    let conversation = match webchat::get(&widget.db, &conversation_id, false).await {
        Ok(Some((conversation, _))) if conversation["visitorId"].as_str() == Some(&visitor_id) => {
            conversation
        }
        Ok(_) => return not_found_error("Conversation", &conversation_id),
        Err(error) => return uncaught(&ctx, &state, &error.to_string()),
    };
    let visitor_name = visitor_display_name(&widget.db, &visitor_id, &conversation).await;
    let now = OffsetDateTime::now_utc().unix_timestamp();
    let token = sign_token(
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_are_hs256_jwts_with_ordered_claims() {
        let token = sign_token("secret", &[("sub", json!("v1")), ("exp", json!(10))]);
        let parts: Vec<&str> = token.split('.').collect();
        assert_eq!(parts.len(), 3);
        let payload = URL_SAFE_NO_PAD.decode(parts[1]).expect("base64url");
        assert_eq!(
            String::from_utf8(payload).expect("utf-8"),
            r#"{"sub":"v1","exp":10}"#
        );
        // Signed with the secret over `header.payload`.
        let mut mac = <Hmac<Sha256> as KeyInit>::new_from_slice(b"secret").expect("key");
        mac.update(format!("{}.{}", parts[0], parts[1]).as_bytes());
        assert!(
            mac.verify_slice(&URL_SAFE_NO_PAD.decode(parts[2]).expect("sig"))
                .is_ok()
        );
    }
}
