//! `middleware/visitor-auth.ts`: visitor authentication for the
//! conversation, realtime and attachment routes. `Authorization: Bearer
//! <visitor token>` (from `POST /api/visitor`) → the visitor row → a
//! [`Visitor`] on the request.
//!
//! Runs after the widget auth: a token only counts for the workspace and
//! widget it was issued for. With identity verification required, a visitor
//! the customer's site never vouched for is refused here too, and an
//! identified visitor's token stops counting once the widget's identity
//! secret is rotated or removed.

use axum::extract::{Request, State};
use axum::http::StatusCode;
use axum::middleware::Next;
use axum::response::Response;
use serde_json::Value;
use time::OffsetDateTime;
use weldsuite_desk_domain::webchat::{self, Principal};

use crate::auth::Widget;
use crate::visitor_identity::{
    identity_secret, identity_secret_fingerprint, is_js_space, read_visitor_token,
    requires_identity,
};
use crate::{Ctx, WidgetState, failure, internal, uncaught};

/// What the middleware puts on the request: `c.get('visitor')` and
/// `c.get('principal')`.
#[derive(Clone)]
pub(crate) struct Visitor {
    /// The `desk_visitors` row, as Drizzle reads it.
    pub(crate) row: Value,
    pub(crate) principal: Principal,
}

impl Visitor {
    pub(crate) fn id(&self) -> &str {
        &self.principal.visitor_id
    }
}

/// The paths it guards, as the `/api` router sees them:
/// `/api/conversations`, `/api/conversations/*`, `/api/realtime/*` and
/// `/api/attachments/*` (Hono's `/x/*` takes `/x` too).
fn guarded(path: &str) -> bool {
    ["/conversations", "/realtime", "/attachments"]
        .iter()
        .any(|prefix| {
            path.strip_prefix(prefix)
                .is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
        })
}

/// `bearerToken(header)`: `/^Bearer\s+(\S+)$/i` on the trimmed header.
pub(crate) fn bearer_token(header: Option<&str>) -> Option<&str> {
    let space = is_js_space;
    let text = header?.trim_matches(space);
    let scheme = text.get(..6)?;
    if !scheme.eq_ignore_ascii_case("bearer") {
        return None;
    }
    let rest = &text[6..];
    let token = rest.trim_start_matches(space);
    if token.len() == rest.len() || token.is_empty() || token.contains(space) {
        return None;
    }
    Some(token)
}

fn unauthorized(code: &str, message: &str) -> Response {
    failure(StatusCode::UNAUTHORIZED, code, message)
}

/// `visitorAuthMiddleware()`.
pub(crate) async fn visitor_auth(
    State(state): State<WidgetState>,
    ctx: Ctx,
    mut request: Request,
    next: Next,
) -> Response {
    if !guarded(request.uri().path()) {
        return next.run(request).await;
    }
    let Some(secret) = ctx.token_secret(&state).filter(|secret| !secret.is_empty()) else {
        return internal("WIDGET_TOKEN_SECRET not configured");
    };
    let header = request
        .headers()
        .get(http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok());
    let Some(token) = bearer_token(header) else {
        return unauthorized("VISITOR_TOKEN_REQUIRED", "Missing visitor token");
    };
    let Some(widget) = request.extensions().get::<Widget>().cloned() else {
        return internal("Internal server error");
    };
    let invalid = || unauthorized("VISITOR_TOKEN_INVALID", "Invalid visitor token");
    let now = OffsetDateTime::now_utc().unix_timestamp();
    let Some(claims) = read_visitor_token(&secret, token, now).filter(|claims| {
        claims.workspace_id == widget.workspace_id && claims.widget_id == widget.id
    }) else {
        return invalid();
    };
    let row = match webchat::find_visitor(&widget.db, &claims.visitor_id).await {
        Ok(Some(row)) => row,
        Ok(None) => return invalid(),
        Err(error) => return uncaught(&ctx, &state, &error.to_string()),
    };
    let identified = row["externalId"]
        .as_str()
        .is_some_and(|external| !external.is_empty());
    if requires_identity(&widget.config) && !identified {
        return unauthorized(
            "IDENTITY_REQUIRED",
            "This chat is only open to signed-in users",
        );
    }
    // An identified visitor's token holds only while the identity secret it
    // was issued under is still the widget's.
    if identified {
        let current = identity_secret(&widget.config).map(identity_secret_fingerprint);
        if current.is_none() || claims.secret_fingerprint != current {
            return invalid();
        }
    }
    let principal = webchat::principal_of(&row);
    request.extensions_mut().insert(Visitor { row, principal });
    next.run(request).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_token_is_the_bearer_credential() {
        assert_eq!(bearer_token(Some("Bearer abc")), Some("abc"));
        assert_eq!(bearer_token(Some("  bearer   abc ")), Some("abc"));
        assert_eq!(bearer_token(Some("BEARER\tabc")), Some("abc"));
        assert_eq!(bearer_token(Some("Bearer")), None);
        assert_eq!(bearer_token(Some("Bearerabc")), None);
        assert_eq!(bearer_token(Some("Bearer a b")), None);
        assert_eq!(bearer_token(Some("Basic abc")), None);
        assert_eq!(bearer_token(None), None);
    }

    #[test]
    fn it_guards_the_visitor_routes() {
        for path in [
            "/conversations",
            "/conversations/x",
            "/realtime/token",
            "/attachments/upload",
            "/realtime",
        ] {
            assert!(guarded(path), "{path}");
        }
        for path in ["/config", "/visitor", "/conversationsx", "/realtimes/token"] {
            assert!(!guarded(path), "{path}");
        }
    }
}
