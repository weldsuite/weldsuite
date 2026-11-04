//! Who is calling: `clerkMiddleware()` (`middleware/clerk.ts`), the Clerk
//! Billing entitlements in its claims (`lib/billing.ts`), and
//! `personalAccountMiddleware()` (`middleware/personal-account.ts`), for
//! every `/api/*` request.

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::{Request, State};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use serde_json::{Map, Value, json};
use weldsuite_auth::SessionVerifier;
use weldsuite_kit::ApiError;

use crate::PersonalState;

/// The personal account summary the middleware loads.
#[derive(Debug, Clone)]
pub(crate) struct Account {
    pub(crate) id: String,
    pub(crate) clerk_user_id: String,
    pub(crate) display_name: Option<String>,
}

impl Account {
    /// `{ id, clerkUserId, displayName }`.
    pub(crate) fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "clerkUserId": self.clerk_user_id,
            "displayName": self.display_name,
        })
    }
}

/// `PersonalEntitlements`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Entitlements {
    pub(crate) pro_mail: bool,
    pub(crate) pro_calendar: bool,
}

impl Entitlements {
    /// `plan`.
    pub(crate) fn plan(&self) -> &'static str {
        if self.pro_mail { "pro" } else { "free" }
    }

    /// `dailySendLimit`.
    pub(crate) fn daily_send_limit(&self) -> i64 {
        if self.pro_mail { 500 } else { 50 }
    }

    /// `maxCalendars`.
    pub(crate) fn max_calendars(&self) -> i64 {
        if self.pro_calendar { 10 } else { 1 }
    }

    /// `maxBookingPages`.
    pub(crate) fn max_booking_pages(&self) -> i64 {
        if self.pro_calendar { 10 } else { 1 }
    }

    /// The object, in `{ ...mail, ...calendar }` order.
    pub(crate) fn to_json(&self) -> Value {
        json!({
            "plan": self.plan(),
            "maxAddresses": 1,
            "dailySendLimit": self.daily_send_limit(),
            "calendarPlan": if self.pro_calendar { "pro" } else { "free" },
            "maxCalendars": self.max_calendars(),
            "maxBookingPages": self.max_booking_pages(),
        })
    }
}

/// What the middleware puts on the request.
#[derive(Debug, Clone)]
pub(crate) struct Session {
    pub(crate) user_id: String,
    pub(crate) entitlements: Entitlements,
    pub(crate) account: Option<Account>,
}

/// `PERSONAL_AUTHORIZED_PARTIES`: the consumer WeldMail and WeldCalendar web
/// apps and their local dev servers.
const PERSONAL_AUTHORIZED_PARTIES: [&str; 7] = [
    "https://mail.weldmail.com",
    "https://weldmail.weldsuite.org",
    "https://weldmail-test.weldsuite.org",
    "https://weldcalendar.weldsuite.org",
    "https://weldcalendar-test.weldsuite.org",
    "http://localhost:3200",
    "http://localhost:3201",
];

/// `PERSONAL_WEB_HOSTS`: one extra subdomain label is allowed on each.
const PERSONAL_WEB_HOSTS: [&str; 5] = [
    "weldmail.com",
    "weldmail-web.pages.dev",
    "weldmail-web-test.pages.dev",
    "weldcalendar-web.pages.dev",
    "weldcalendar-web-test.pages.dev",
];

/// `/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/`.
fn is_dns_label(label: &str) -> bool {
    let bytes = label.as_bytes();
    let edge = |b: &u8| b.is_ascii_lowercase() || b.is_ascii_digit();
    !bytes.is_empty()
        && bytes.len() <= 63
        && bytes.first().is_some_and(edge)
        && bytes.last().is_some_and(edge)
        && bytes.iter().all(|b| edge(b) || *b == b'-')
}

/// `isPersonalWebOrigin(origin)`: `https://` and a host of
/// `[a-z0-9.-]+` on a consumer web host or one label under it.
fn is_personal_web_origin(origin: &str) -> bool {
    let Some(host) = origin.strip_prefix("https://") else {
        return false;
    };
    if host.is_empty()
        || !host
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'-')
    {
        return false;
    }
    PERSONAL_WEB_HOSTS.iter().any(|base| {
        if host == *base {
            return true;
        }
        host.strip_suffix(base)
            .and_then(|rest| rest.strip_suffix('.'))
            .is_some_and(is_dns_label)
    })
}

/// `isAuthorizedParty(azp, extraOrigins)`: no claim passes (native clients);
/// a claim that is present but empty or not a string does not.
pub(crate) fn is_authorized_party(azp: Option<&Value>, extra: &[String]) -> bool {
    match azp {
        None | Some(Value::Null) => true,
        Some(Value::String(azp)) if !azp.is_empty() => {
            PERSONAL_AUTHORIZED_PARTIES.contains(&azp.as_str())
                || is_personal_web_origin(azp)
                || extra.iter().any(|origin| origin == azp)
        }
        Some(_) => false,
    }
}

/// `claimSlugs(claim)`: split on commas and white space, scope prefix
/// (`u:` / `o:`) stripped, lower-cased.
fn claim_slugs(claim: &str) -> impl Iterator<Item = String> + '_ {
    claim
        .split(|c: char| c == ',' || crate::js::is_js_space(c))
        .map(|part| strip_scope(part).to_lowercase())
}

/// `.replace(/^[uo]:/, '')`.
fn strip_scope(slug: &str) -> &str {
    slug.strip_prefix("u:")
        .or_else(|| slug.strip_prefix("o:"))
        .unwrap_or(slug)
}

/// `String(value)` of a plan entry's `slug`.
fn slug_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Null => "null".to_owned(),
        other => crate::js::js_string(other),
    }
}

/// `planItemSlug(item)`.
fn plan_item_slug(item: &Value) -> String {
    match item {
        Value::String(text) => text.clone(),
        Value::Object(map) => map.get("slug").map(slug_text).unwrap_or_default(),
        _ => String::new(),
    }
}

/// `planClaimMatches(pla, planSlugs)`.
fn plan_claim_matches(pla: Option<&Value>, slugs: &[&str]) -> bool {
    match pla {
        Some(Value::String(claim)) => claim_slugs(claim).any(|slug| slugs.contains(&slug.as_str())),
        Some(Value::Object(object)) => ["u", "o", "plans", "user"].iter().any(|key| {
            object
                .get(*key)
                .and_then(Value::as_array)
                .is_some_and(|list| {
                    list.iter().any(|item| {
                        let slug = plan_item_slug(item);
                        slugs.contains(&strip_scope(&slug).to_lowercase().as_str())
                    })
                })
        }),
        _ => false,
    }
}

/// `metadataMatches(meta, planSlugs)`.
fn metadata_matches(meta: Option<&Value>, slugs: &[&str]) -> bool {
    let Some(Value::Object(meta)) = meta else {
        return false;
    };
    let plan = meta
        .get("plan")
        .and_then(Value::as_str)
        .map(str::to_lowercase)
        .unwrap_or_default();
    if slugs.contains(&plan.as_str()) {
        return true;
    }
    meta.get("plans")
        .and_then(Value::as_array)
        .is_some_and(|plans| {
            plans
                .iter()
                .filter_map(Value::as_str)
                .any(|plan| slugs.contains(&plan.to_lowercase().as_str()))
        })
}

/// `hasSlugAccess(payload, planSlugs, featureSlugs)`.
fn has_slug_access(claims: &Map<String, Value>, plans: &[&str], features: &[&str]) -> bool {
    if let Some(Value::String(fea)) = claims.get("fea")
        && claim_slugs(fea).any(|slug| features.contains(&slug.as_str()))
    {
        return true;
    }
    if plan_claim_matches(claims.get("pla"), plans) {
        return true;
    }
    // `payload.public_metadata ?? payload.publicMetadata`.
    let meta = match claims.get("public_metadata") {
        None | Some(Value::Null) => claims.get("publicMetadata"),
        some => some,
    };
    metadata_matches(meta, plans)
}

/// `entitlementsFromClerkClaims(payload)`.
pub(crate) fn entitlements_from_claims(claims: &Map<String, Value>) -> Entitlements {
    const MAIL: [&str; 2] = ["weldmail_pro", "pro"];
    const CALENDAR: [&str; 1] = ["weldcalendar_pro"];
    Entitlements {
        pro_mail: has_slug_access(claims, &MAIL, &MAIL),
        pro_calendar: has_slug_access(claims, &CALENDAR, &CALENDAR),
    }
}

/// `allowsMissingAccount(path)`.
fn allows_missing_account(path: &str) -> bool {
    path == "/api/onboard"
        || path.starts_with("/api/onboard/")
        || path == "/api/me"
        || path.starts_with("/api/me/")
        || path == "/api/mail/weldmail/domain"
        || path == "/api/mail/weldmail/check"
}

fn unauthorized(message: &str) -> Response {
    ApiError::unauthorized()
        .with_message(message)
        .into_response()
}

/// `app.use('/api/*', clerkMiddleware())` then
/// `app.use('/api/*', personalAccountMiddleware())`.
pub(crate) async fn session(
    State(state): State<Arc<PersonalState>>,
    mut request: Request,
    next: Next,
) -> Response {
    let path = request.uri().path().to_owned();
    if path != "/api" && !path.starts_with("/api/") {
        return next.run(request).await;
    }

    let authorization = request
        .headers()
        .get(http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    if !authorization
        .as_deref()
        .is_some_and(|value| value.starts_with("Bearer "))
    {
        return unauthorized("Missing or invalid Authorization header");
    }
    let verifier = request
        .extensions()
        .get::<Arc<SessionVerifier>>()
        .cloned()
        .or_else(|| state.verifier.clone());
    let Some(verifier) = verifier else {
        tracing::error!("[personal-api] no session verifier is configured");
        return unauthorized("Token verification failed");
    };
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs());
    let session = match verifier
        .authenticate_with(authorization.as_deref(), now, &is_authorized_party)
        .await
    {
        Ok(session) => session,
        Err(error) => return error.into_response(),
    };
    let user_id = session.context.user_id;
    let entitlements = entitlements_from_claims(&session.claims);

    // The personal account, from the master database.
    let master = request
        .extensions()
        .get::<weldsuite_db::MasterDb>()
        .map(|master| master.0.clone())
        .or_else(|| state.master.clone());
    let lookup = async {
        let Some(master) = master else {
            return Err(sqlx::Error::Configuration(
                "DATABASE_URL_MASTER secret is not set".into(),
            ));
        };
        sqlx::query_as::<_, (String, String, Option<String>)>(
            "select id, clerk_user_id, display_name from personal_accounts
             where clerk_user_id = $1 limit 1",
        )
        .bind(&user_id)
        .fetch_optional(&master)
        .await
    };
    let account = match lookup.await {
        Ok(row) => row.map(|(id, clerk_user_id, display_name)| Account {
            id,
            clerk_user_id,
            display_name,
        }),
        Err(error) => {
            tracing::error!(%error, "[personal-account] lookup failed");
            return ApiError::internal()
                .with_message("Failed to load personal account")
                .into_response();
        }
    };
    if account.is_none() && !allows_missing_account(&path) {
        return crate::caller::personal_account_required();
    }
    request.extensions_mut().insert(Session {
        user_id,
        entitlements,
        account,
    });
    next.run(request).await
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn claims(value: Value) -> Map<String, Value> {
        match value {
            Value::Object(map) => map,
            _ => Map::new(),
        }
    }

    #[test]
    fn authorized_parties_are_the_consumer_apps() {
        let ok = |azp: Value| is_authorized_party(Some(&azp), &[]);
        assert!(is_authorized_party(None, &[]));
        assert!(ok(json!("https://mail.weldmail.com")));
        assert!(ok(json!("https://feature-x.weldmail-web-test.pages.dev")));
        assert!(ok(json!("https://weldmail.com")));
        assert!(!ok(json!("https://a.b.weldmail.com")));
        assert!(!ok(json!("https://-x.weldmail.com")));
        assert!(!ok(json!("https://app.weldsuite.org")));
        assert!(!ok(json!("http://weldmail.com")));
        assert!(!ok(json!("")));
        assert!(!ok(json!(42)));
        assert!(is_authorized_party(
            Some(&json!("https://x.example")),
            &["https://x.example".to_owned()]
        ));
    }

    #[test]
    fn plans_come_from_the_claims() {
        let e = |value: Value| entitlements_from_claims(&claims(value));
        assert_eq!(e(json!({})).to_json()["plan"], "free");
        assert!(e(json!({ "fea": "u:weldmail_pro, u:other" })).pro_mail);
        assert!(e(json!({ "pla": "o:weldcalendar_pro" })).pro_calendar);
        assert!(e(json!({ "pla": { "u": [{ "slug": "u:pro" }] } })).pro_mail);
        assert!(e(json!({ "pla": { "plans": ["WELDCALENDAR_PRO"] } })).pro_calendar);
        assert!(e(json!({ "publicMetadata": { "plan": "WELDMAIL_PRO" } })).pro_mail);
        assert!(e(json!({ "public_metadata": { "plans": ["weldcalendar_pro"] } })).pro_calendar);
        assert!(!e(json!({ "fea": "weldcalendar_pro" })).pro_mail);
    }
}
