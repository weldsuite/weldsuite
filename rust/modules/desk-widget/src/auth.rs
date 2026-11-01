//! `middleware/widget-auth.ts`: `x-widget-id` → the master `widget_registry`
//! → the workspace → its tenant `desk_widget_settings`, and the widget's
//! allowed-domains policy. A request that passes carries a [`Widget`].

use axum::extract::{Request, State};
use axum::http::StatusCode;
use axum::middleware::Next;
use axum::response::Response;
use serde_json::Value;
use weldsuite_db::PgPool;

use crate::{Ctx, WidgetState, failure};

/// What `widgetAuthMiddleware` puts on the context.
#[derive(Clone)]
pub(crate) struct Widget {
    /// `c.get('widgetId')`.
    pub(crate) id: String,
    /// `c.get('workspaceId')`: `workspaces.id` of the widget's workspace
    /// (ADR SEC-011); visitor tokens are bound to it.
    pub(crate) workspace_id: String,
    /// `c.get('clerkOrgId')`: events, attachment keys and realtime use it.
    pub(crate) clerk_org_id: String,
    /// `c.get('widgetConfig')`: the `desk_widget_settings` row as
    /// `to_jsonb` reads it (column names).
    pub(crate) config: Value,
    /// `c.get('tenantDb')`.
    pub(crate) db: PgPool,
    /// `c.get('removeBranding')`.
    pub(crate) remove_branding: bool,
}

fn unauthorized(message: &str) -> Response {
    failure(StatusCode::UNAUTHORIZED, "UNAUTHORIZED", message)
}

fn forbidden(message: &str) -> Response {
    failure(StatusCode::FORBIDDEN, "FORBIDDEN", message)
}

/// `widgetAuthMiddleware()`.
pub(crate) async fn widget_auth(
    State(state): State<WidgetState>,
    ctx: Ctx,
    mut request: Request,
    next: Next,
) -> Response {
    let Some(widget_id) = request
        .headers()
        .get("x-widget-id")
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
    else {
        return unauthorized("Missing x-widget-id header");
    };
    // An empty `Origin` counts as none (`!origin`).
    let origin = request
        .headers()
        .get(http::header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    match authenticate(&ctx, &state, widget_id, origin.as_deref()).await {
        Ok(Ok(widget)) => {
            request.extensions_mut().insert(widget);
            next.run(request).await
        }
        Ok(Err(refusal)) => refusal,
        Err(error) => {
            tracing::error!(%error, "[Widget Auth] Database error");
            failure(
                StatusCode::INTERNAL_SERVER_ERROR,
                "INTERNAL_ERROR",
                "Failed to authenticate widget",
            )
        }
    }
}

/// The widget, the middleware's refusal, or the error that made it fail.
async fn authenticate(
    ctx: &Ctx,
    state: &WidgetState,
    widget_id: String,
    origin: Option<&str>,
) -> Result<Result<Widget, Response>, String> {
    let master = ctx.master(state).ok_or("no master database")?;
    let registry: Option<(String, bool)> = sqlx::query_as(
        "select workspace_id, is_active from widget_registry where widget_id = $1 limit 1",
    )
    .bind(&widget_id)
    .fetch_optional(&master)
    .await
    .map_err(|error| error.to_string())?;
    let Some((workspace_id, active)) = registry else {
        return Ok(Err(unauthorized("Invalid widget ID")));
    };
    if !active {
        return Ok(Err(unauthorized("Widget is inactive")));
    }
    let workspace: Option<(Option<String>, Option<String>)> =
        sqlx::query_as("select clerk_org_id, plan_id from workspaces where id = $1 limit 1")
            .bind(&workspace_id)
            .fetch_optional(&master)
            .await
            .map_err(|error| error.to_string())?;
    let Some((Some(clerk_org_id), plan_id)) =
        workspace.filter(|(org, _)| org.as_deref().is_some_and(|org| !org.is_empty()))
    else {
        return Ok(Err(unauthorized("Workspace configuration not found")));
    };
    let remove_branding = match plan_id {
        Some(plan_id) => sqlx::query_scalar::<_, Option<bool>>(
            "select remove_branding from plans where id = $1 limit 1",
        )
        .bind(&plan_id)
        .fetch_optional(&master)
        .await
        .map_err(|error| error.to_string())?
        .flatten()
        .unwrap_or(false),
        None => false,
    };
    let db = ctx.tenant_db(state, &clerk_org_id).await?;
    let config: Option<Value> = sqlx::query_scalar(
        "select to_jsonb(t) from desk_widget_settings t where t.widget_id = $1 limit 1",
    )
    .bind(&widget_id)
    .fetch_optional(&db)
    .await
    .map_err(|error| error.to_string())?;
    let Some(config) = config else {
        return Ok(Err(unauthorized("Widget configuration not found")));
    };
    if config["enabled"] != Value::Bool(true) {
        return Ok(Err(forbidden("Widget is disabled")));
    }
    // Once a workspace has an allowlist, a request without `Origin` is a
    // non-browser client and is refused too: every legitimate caller is the
    // widget's cross-origin fetch, which always sends it.
    let allowed: Vec<&str> = config["allowed_domains"]
        .as_array()
        .map(|domains| domains.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let listed = config["allowed_domains"]
        .as_array()
        .is_some_and(|domains| !domains.is_empty());
    if listed {
        let Some(origin) = origin else {
            return Ok(Err(forbidden("Origin header required")));
        };
        if !origin_allowed(origin, &allowed) {
            return Ok(Err(forbidden("Origin not allowed")));
        }
    }
    Ok(Ok(Widget {
        id: widget_id,
        workspace_id,
        clerk_org_id,
        config,
        db,
        remove_branding,
    }))
}

/// `normalizeAllowedDomain(entry)`: a bare lowercase hostname, without a
/// scheme, port, path, query, fragment or leading `*.`/`.`.
fn normalize_allowed_domain(entry: &str) -> String {
    let lower = weldsuite_kit::validation::js_trim(entry).to_lowercase();
    let without_scheme = strip_scheme(&lower);
    let host_and_port = without_scheme
        .find(['/', '?', '#'])
        .map_or(without_scheme, |end| &without_scheme[..end]);
    // `.replace(/:\d+$/, '')`.
    let host = match host_and_port.rfind(':') {
        Some(colon)
            if colon + 1 < host_and_port.len()
                && host_and_port[colon + 1..]
                    .bytes()
                    .all(|b| b.is_ascii_digit()) =>
        {
            &host_and_port[..colon]
        }
        _ => host_and_port,
    };
    // `.replace(/^\*?\./, '')`: a `*` only goes with the dot after it.
    host.strip_prefix("*.")
        .or_else(|| host.strip_prefix('.'))
        .unwrap_or(host)
        .to_owned()
}

/// `/^[a-z][a-z\d+.-]*:\/\//`.
fn strip_scheme(text: &str) -> &str {
    let Some(end) = text.find("://") else {
        return text;
    };
    let scheme = &text[..end];
    let mut chars = scheme.chars();
    let valid = chars.next().is_some_and(|c| c.is_ascii_lowercase())
        && chars
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '+' | '.' | '-'));
    if valid { &text[end + 3..] } else { text }
}

/// `new URL(origin).hostname`, or the origin lowercased when it does not
/// parse.
fn origin_host(origin: &str) -> String {
    let lower = origin.to_lowercase();
    let Some(end) = lower.find("://") else {
        return lower;
    };
    let rest = &lower[end + 3..];
    let authority = rest.find(['/', '?', '#']).map_or(rest, |end| &rest[..end]);
    let authority = authority
        .rsplit_once('@')
        .map_or(authority, |(_, host)| host);
    if let Some(bracketed) = authority.strip_prefix('[') {
        return bracketed.find(']').map_or_else(
            || lower.clone(),
            |close| format!("[{}]", &bracketed[..close]),
        );
    }
    let host = authority.split(':').next().unwrap_or(authority);
    if host.is_empty() {
        lower
    } else {
        host.to_owned()
    }
}

/// `isOriginAllowed(origin, allowedDomains)`: the origin's host equals, or
/// is a subdomain of, an allowed domain.
fn origin_allowed(origin: &str, allowed: &[&str]) -> bool {
    let host = origin_host(origin);
    allowed.iter().any(|entry| {
        let domain = normalize_allowed_domain(entry);
        !domain.is_empty() && (host == domain || host.ends_with(&format!(".{domain}")))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allowed_domains_are_normalised() {
        assert_eq!(normalize_allowed_domain("Example.com"), "example.com");
        assert_eq!(
            normalize_allowed_domain(" https://example.com:8443/path?q#f "),
            "example.com"
        );
        assert_eq!(normalize_allowed_domain("*.example.com"), "example.com");
        assert_eq!(normalize_allowed_domain(".example.com"), "example.com");
        assert_eq!(normalize_allowed_domain("example.com:80"), "example.com");
        assert_eq!(normalize_allowed_domain("*example.com"), "*example.com");
        assert_eq!(normalize_allowed_domain(""), "");
    }

    #[test]
    fn origins_match_the_domain_and_its_subdomains() {
        let allowed = ["example.com"];
        assert!(origin_allowed("https://example.com", &allowed));
        assert!(origin_allowed("https://shop.example.com:8443", &allowed));
        assert!(!origin_allowed("https://evilexample.com", &allowed));
        assert!(!origin_allowed("https://example.com.evil.test", &allowed));
        assert!(!origin_allowed("https://other.test", &[""]));
    }
}
