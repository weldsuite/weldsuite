//! `routes/knowledge.ts` and `lib/optional-visitor.ts`: self-service in the
//! widget, behind the widget auth.
//!
//! - `GET /api/articles/search?q=&locale=&limit=`: articles that might answer
//!   what the visitor is typing, the help center's published articles they
//!   may read, in their language when a version exists, best match first
//!   (1–5, default 3), each with its help-center URL when the help center is
//!   live.
//! - `GET /api/announcements`: the status banners they may see.
//!
//! The visitor token is optional: a token that holds (this workspace and
//! widget, a visitor row, the current identity secret for an identified
//! visitor) names the reader; anything else reads as anonymous. Query values
//! are read leniently, so neither route refuses a request.

use axum::Extension;
use axum::extract::{RawQuery, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use serde_json::{Value, json};
use time::OffsetDateTime;
use weldsuite_desk_domain::articles::{
    Reader, announcements_for, normalize_locale, reader_of, search_for_reader, typed_search,
};
use weldsuite_desk_domain::webchat::{self, Principal};

use crate::auth::Widget;
use crate::visitor_auth::bearer_token;
use crate::visitor_identity::{identity_secret, identity_secret_fingerprint, read_visitor_token};
use crate::{Ctx, WidgetState, internal, success};

const DEFAULT_LIMIT: i64 = 3;
const MAX_LIMIT: i64 = 5;

/// `c.req.query(key)`: the first value of `key`, decoded.
fn query_value(query: Option<&str>, key: &str) -> Option<String> {
    form_urlencoded::parse(query?.as_bytes())
        .find(|(name, _)| name == key)
        .map(|(_, value)| value.into_owned())
}

/// `Number.parseInt(raw, 10)`: leading space, a sign, then digits; `None`
/// for JavaScript's `NaN`.
fn js_parse_int(raw: &str) -> Option<i64> {
    let text = raw.trim_start_matches(crate::visitor_identity::is_js_space);
    let (negative, digits) = match text.as_bytes().first() {
        Some(b'-') => (true, &text[1..]),
        Some(b'+') => (false, &text[1..]),
        _ => (false, text),
    };
    let digits: &str = &digits[..digits.bytes().take_while(u8::is_ascii_digit).count()];
    if digits.is_empty() {
        return None;
    }
    let value = digits.bytes().fold(0i64, |n, b| {
        n.saturating_mul(10).saturating_add(i64::from(b - b'0'))
    });
    Some(if negative { -value } else { value })
}

/// `limitOf(raw)`.
fn limit_of(raw: Option<&str>) -> i64 {
    js_parse_int(raw.unwrap_or_default()).map_or(DEFAULT_LIMIT, |n| n.clamp(1, MAX_LIMIT))
}

/// `c.req.query('locale')?.slice(0, 10)`, normalised.
fn locale_of(query: Option<&str>) -> Option<String> {
    let raw = query_value(query, "locale")?;
    let units: Vec<u16> = raw.encode_utf16().take(10).collect();
    normalize_locale(Some(&String::from_utf16_lossy(&units)))
}

/// `optionalVisitorPrincipal(c)`.
async fn optional_principal(
    ctx: &Ctx,
    state: &WidgetState,
    widget: &Widget,
    headers: &HeaderMap,
) -> Result<Option<Principal>, sqlx::Error> {
    let secret = ctx.token_secret(state).filter(|secret| !secret.is_empty());
    let header = headers
        .get(http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok());
    let (Some(secret), Some(token)) = (secret, bearer_token(header)) else {
        return Ok(None);
    };
    let now = OffsetDateTime::now_utc().unix_timestamp();
    let Some(claims) = read_visitor_token(&secret, token, now).filter(|claims| {
        claims.workspace_id == widget.workspace_id && claims.widget_id == widget.id
    }) else {
        return Ok(None);
    };
    let Some(row) = webchat::find_visitor(&widget.db, &claims.visitor_id).await? else {
        return Ok(None);
    };
    let identified = row["externalId"]
        .as_str()
        .is_some_and(|external| !external.is_empty());
    if identified {
        let current = identity_secret(&widget.config).map(identity_secret_fingerprint);
        if current.is_none() || claims.secret_fingerprint != current {
            return Ok(None);
        }
    }
    Ok(Some(webchat::principal_of(&row)))
}

/// `deskReaderOf(db, await optionalVisitorPrincipal(c))`.
async fn reader(
    ctx: &Ctx,
    state: &WidgetState,
    widget: &Widget,
    headers: &HeaderMap,
) -> Result<Reader, sqlx::Error> {
    let principal = optional_principal(ctx, state, widget, headers).await?;
    let email = principal.and_then(|principal| principal.verified_email);
    reader_of(&widget.db, email.as_deref()).await
}

/// `GET /api/articles/search`.
pub(crate) async fn search(
    State(state): State<WidgetState>,
    ctx: Ctx,
    Extension(widget): Extension<Widget>,
    headers: HeaderMap,
    RawQuery(query): RawQuery,
) -> Response {
    let query = query.as_deref();
    let Some(search) = typed_search(&query_value(query, "q").unwrap_or_default()) else {
        return success(StatusCode::OK, json!([]));
    };
    let hits = async {
        let reader = reader(&ctx, &state, &widget, &headers).await?;
        let locale = locale_of(query);
        let limit = limit_of(query_value(query, "limit").as_deref());
        search_for_reader(&widget.db, &reader, &search, locale.as_deref(), limit).await
    }
    .await;
    match hits {
        Ok(hits) => success(StatusCode::OK, Value::Array(hits)),
        Err(error) => {
            tracing::error!(%error, "[widget-api/knowledge] article search failed");
            internal("Failed to search articles")
        }
    }
}

/// `GET /api/announcements`.
pub(crate) async fn announcements(
    State(state): State<WidgetState>,
    ctx: Ctx,
    Extension(widget): Extension<Widget>,
    headers: HeaderMap,
) -> Response {
    let list = async {
        let reader = reader(&ctx, &state, &widget, &headers).await?;
        announcements_for(&widget.db, &reader).await
    }
    .await;
    match list {
        Ok(list) => success(StatusCode::OK, Value::Array(list)),
        Err(error) => {
            tracing::error!(%error, "[widget-api/knowledge] announcements failed");
            internal("Failed to load announcements")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_limit_is_read_like_parse_int() {
        assert_eq!(limit_of(None), 3);
        assert_eq!(limit_of(Some("abc")), 3);
        assert_eq!(limit_of(Some("0")), 1);
        assert_eq!(limit_of(Some(" 2.5")), 2);
        assert_eq!(limit_of(Some("-4")), 1);
        assert_eq!(limit_of(Some("99999999999999999999999")), 5);
    }

    #[test]
    fn query_values_are_decoded() {
        assert_eq!(
            query_value(Some("q=reset+pass&q=x"), "q").as_deref(),
            Some("reset pass")
        );
        assert_eq!(locale_of(Some("locale=NL")).as_deref(), Some("nl"));
        assert_eq!(locale_of(Some("other=1")), None);
    }
}
