//! `routes/visitor.ts`: `POST /api/visitor`, the widget's visitor session.
//!
//! The widget calls it on load and gets back a visitor token, which every
//! other visitor route requires. Who the visitor is, in order:
//!
//! 1. `identityToken`: the customer's server vouches for a user (verified,
//!    see [`crate::visitor_identity`]). One visitor per (widget, user id).
//! 2. `visitorToken`: this browser's own anonymous visitor, kept. A token for
//!    an identified visitor without an identity token means the user signed
//!    out on the customer's site: they get a fresh anonymous visitor.
//! 3. `legacyVisitorId`: transition from the browser-made ids. An existing
//!    anonymous visitor can swap its id for a token, once (a marker in the
//!    workspace cache).
//! 4. Otherwise a new anonymous visitor.
//!
//! With identity verification required, 2 to 4 are refused.

use std::time::Duration;

use axum::Extension;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use serde_json::{Map, Value, json};
use time::OffsetDateTime;
use weldsuite_desk_domain::webchat::{self, DESK_VISITORS, IdentifiedVisitor};
use weldsuite_kit::validation::{Issues, Presence, Text};

use crate::auth::Widget;
use crate::conversations::json as json_body_of;
use crate::live::publish_conversation_updated;
use crate::visitor_identity::{
    VisitorClaims, identity_secret, identity_secret_fingerprint, issue_visitor_token,
    read_visitor_token, requires_identity, verify_identity_token,
};
use crate::{Ctx, WidgetState, bad_request, failure, internal, success};

/// How long the "this legacy id was swapped already" marker is kept.
const LEGACY_EXCHANGE_TTL: Duration = Duration::from_hours(400 * 24);

fn legacy_key(workspace_id: &str, visitor_id: &str) -> String {
    format!("dvis:legacy:{workspace_id}:{visitor_id}")
}

/// `z.string().min(1).max(max).optional()`.
fn optional_token(
    issues: &mut Issues,
    body: &Map<String, Value>,
    key: &str,
    max: usize,
) -> Option<String> {
    issues
        .text_with(
            body,
            key,
            Presence::Optional,
            Text::length(Some(1), Some(max)),
        )
        .into_option()
}

/// A string column that is set (`visitor.externalId`, `visitor.verifiedEmail`).
fn set(row: &Value, prop: &str) -> bool {
    row[prop].as_str().is_some_and(|value| !value.is_empty())
}

/// `POST /api/visitor`.
pub(crate) async fn session(
    State(state): State<WidgetState>,
    ctx: Ctx,
    Extension(widget): Extension<Widget>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let read = json_body_of(&ctx, &state, &headers, &body, |issues, body| {
        (
            optional_token(issues, body, "identityToken", 4096),
            optional_token(issues, body, "visitorToken", 2048),
            optional_token(issues, body, "legacyVisitorId", 64),
        )
    });
    let request = match read {
        Ok(request) => request,
        Err(refusal) => return refusal,
    };
    let Some(secret) = ctx.token_secret(&state).filter(|secret| !secret.is_empty()) else {
        return internal("WIDGET_TOKEN_SECRET not configured");
    };
    match start(&state, &ctx, &widget, &secret, request).await {
        Ok(response) => response,
        Err(error) => {
            tracing::error!(%error, "[widget-api] visitor session failed");
            internal("Failed to start the visitor session")
        }
    }
}

/// The session for the request's `(identityToken, visitorToken, legacyVisitorId)`.
async fn start(
    state: &WidgetState,
    ctx: &Ctx,
    widget: &Widget,
    secret: &str,
    (identity_token, visitor_token, legacy_id): (Option<String>, Option<String>, Option<String>),
) -> Result<Response, String> {
    let db = &widget.db;
    let now = OffsetDateTime::now_utc().unix_timestamp();
    // Identified sessions end with their identity token and with the secret
    // it was signed under.
    let mut identified: Option<(f64, String)> = None;
    let visitor = if let Some(identity_token) = identity_token {
        match identified_visitor(state, widget, &identity_token, now).await? {
            Ok((visitor, session)) => {
                identified = Some(session);
                visitor
            }
            Err(refusal) => return Ok(refusal),
        }
    } else {
        if requires_identity(&widget.config) {
            return Ok(failure(
                StatusCode::UNAUTHORIZED,
                "IDENTITY_REQUIRED",
                "This chat is only open to signed-in users",
            ));
        }
        let kept = match visitor_token {
            Some(token) => kept_visitor(widget, secret, &token, now).await?,
            None => None,
        };
        let found = match (kept, legacy_id) {
            (Some(kept), _) => Some(kept),
            (None, Some(legacy_id)) => {
                exchanged_legacy_visitor(state, ctx, widget, &legacy_id).await?
            }
            (None, None) => None,
        };
        match found {
            Some(visitor) => touch(widget, visitor).await?,
            None => webchat::create_anonymous_visitor(db, Some(&widget.id))
                .await
                .map_err(|error| error.to_string())?,
        }
    };

    let claims = VisitorClaims {
        visitor_id: visitor["id"].as_str().unwrap_or_default().to_owned(),
        workspace_id: widget.workspace_id.clone(),
        widget_id: widget.id.clone(),
        secret_fingerprint: identified
            .as_ref()
            .map(|(_, fingerprint)| fingerprint.clone()),
    };
    let token = issue_visitor_token(
        secret,
        &claims,
        identified.map(|(expires_at, _)| expires_at),
        now,
    );
    // `visitor.verifiedEmail ?? visitor.email`.
    let email = if visitor["verifiedEmail"].is_null() {
        visitor["email"].clone()
    } else {
        visitor["verifiedEmail"].clone()
    };
    Ok(success(
        StatusCode::OK,
        json!({
            "visitorToken": token,
            "visitor": {
                "id": visitor["id"],
                "name": visitor["name"],
                "email": email,
                "verified": set(&visitor, "verifiedEmail"),
            },
        }),
    ))
}

/// The visitor an identity token vouches for, with the session's end and
/// the identity secret's fingerprint; or the refusal. Their proven contact
/// goes onto the conversations they started before.
async fn identified_visitor(
    state: &WidgetState,
    widget: &Widget,
    identity_token: &str,
    now: i64,
) -> Result<Result<(Value, (f64, String)), Response>, String> {
    let db = &widget.db;
    let Some(identity_secret) = identity_secret(&widget.config) else {
        return Ok(Err(bad_request(
            "Identity verification is not set up for this widget",
        )));
    };
    let identity = match verify_identity_token(identity_secret, identity_token, now) {
        Ok(identity) => identity,
        Err(reason) => {
            return Ok(Err(failure(
                StatusCode::UNAUTHORIZED,
                "IDENTITY_INVALID",
                &format!("Identity token refused ({reason})"),
            )));
        }
    };
    let visitor = webchat::upsert_identified_visitor(
        db,
        IdentifiedVisitor {
            widget_id: &widget.id,
            external_id: &identity.external_id,
            email: identity.email.as_deref(),
            name: identity.name.as_deref(),
        },
    )
    .await
    .map_err(|error| error.to_string())?;
    let updated = webchat::attach_visitor_contact(
        db,
        visitor["id"].as_str().unwrap_or_default(),
        visitor["name"].as_str(),
        visitor["verifiedEmail"].as_str(),
    )
    .await
    .map_err(|error| error.to_string())?;
    let background = state.clone();
    let org = widget.clerk_org_id.clone();
    state.events.tracker().spawn(async move {
        for conversation in &updated {
            publish_conversation_updated(&background, &org, conversation).await;
        }
    });
    let session = (
        identity.expires_at,
        identity_secret_fingerprint(identity_secret),
    );
    Ok(Ok((visitor, session)))
}

/// The anonymous visitor this browser already holds a token for, if still
/// valid here.
async fn kept_visitor(
    widget: &Widget,
    secret: &str,
    token: &str,
    now: i64,
) -> Result<Option<Value>, String> {
    let Some(claims) = read_visitor_token(secret, token, now).filter(|claims| {
        claims.workspace_id == widget.workspace_id && claims.widget_id == widget.id
    }) else {
        return Ok(None);
    };
    let visitor = webchat::find_visitor(&widget.db, &claims.visitor_id)
        .await
        .map_err(|error| error.to_string())?;
    Ok(visitor.filter(|visitor| !set(visitor, "externalId")))
}

/// A browser-made id from before visitor tokens, swapped once for its
/// existing visitor. The worker reads its cache binding unguarded, so a
/// deployment without one fails here as it does.
async fn exchanged_legacy_visitor(
    state: &WidgetState,
    ctx: &Ctx,
    widget: &Widget,
    legacy_id: &str,
) -> Result<Option<Value>, String> {
    let Some(visitor) = webchat::find_visitor(&widget.db, legacy_id)
        .await
        .map_err(|error| error.to_string())?
    else {
        return Ok(None);
    };
    if set(&visitor, "externalId") || set(&visitor, "verifiedEmail") {
        return Ok(None);
    }
    if visitor["widgetId"]
        .as_str()
        .is_some_and(|owner| !owner.is_empty() && owner != widget.id)
    {
        return Ok(None);
    }
    let kv = ctx.kv(state).ok_or("WORKSPACE_CACHE is not bound")?;
    let id = visitor["id"].as_str().unwrap_or_default();
    let key = legacy_key(&widget.workspace_id, id);
    let marker = kv
        .get_boxed(&key)
        .await
        .map_err(|error| error.to_string())?;
    if marker.is_some_and(|marker| !marker.is_empty()) {
        return Ok(None);
    }
    kv.put_boxed(&key, &webchat::now(), Some(LEGACY_EXCHANGE_TTL))
        .await
        .map_err(|error| error.to_string())?;
    Ok(Some(visitor))
}

/// Move a returning visitor's last-seen time on; one without a widget takes
/// this one.
async fn touch(widget: &Widget, visitor: Value) -> Result<Value, String> {
    let now = webchat::now();
    let mut changes = Map::new();
    changes.insert("last_seen_at".to_owned(), json!(now));
    changes.insert("updated_at".to_owned(), json!(now));
    changes.insert(
        "widget_id".to_owned(),
        if visitor["widgetId"].is_null() {
            json!(widget.id)
        } else {
            visitor["widgetId"].clone()
        },
    );
    let id = visitor["id"].as_str().unwrap_or_default().to_owned();
    let updated = DESK_VISITORS
        .patch(
            &widget.db,
            &id,
            changes,
            false,
            &["lastSeenAt", "updatedAt"],
        )
        .await
        .map_err(|error| error.to_string())?;
    Ok(updated.unwrap_or(visitor))
}
