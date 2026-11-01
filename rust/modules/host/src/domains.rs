//! `/api/domains` (`routes/domains`, `@weldsuite/host-domain/domains`):
//! dashboard, search and availability (Realtime Register, priced from the
//! master `domain_pricing`), checkout (billing is Global's: answers as the
//! worker does without Stripe), external domains and their ownership check
//! (a TXT record over DNS over HTTPS, then a zone at the DNS host), the
//! registrar toggles, sync, renewal, auth codes and registration polling.
//! Permissions `domains:read|create|update|delete`; events `domain:*` (and
//! `dns_zone:created`).

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use http::{HeaderMap, StatusCode};
use serde_json::{Map, Value, json};
use time::{Duration, OffsetDateTime};
use weldsuite_catalogs::entity_events::{
    DNS_ZONE_CREATED, DOMAIN_CREATED, DOMAIN_DELETED, DOMAIN_UPDATED, DOMAIN_USE_EXTERNAL,
};
use weldsuite_db::PgPool;
use weldsuite_events::iso_timestamp;
use weldsuite_kit::validation::{Field, Format, Issues, Number, Presence, Text, js_date_iso};
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::cloudflare::RegistrarError;
use crate::dns_host::ZoneErrorKind;
use crate::js::{as_text, number_json, parse_float, parse_int, random_uuid_hex, round, text, tld_of};
use crate::registrar::{CheckResult, OTE_SEARCH_DEFAULT_TLDS, Outcome, RealtimeRegistrar, RtrError, js_slice_end, tld_supports_privacy_protect};
use crate::rows::{any_domain, any_zone, domain_with_zone, is_external_registrar, is_hidden_unpaid, live_domain, live_zone_of_domain, public_domain};
use crate::weldreach::{changes_nameservers, connected_domain_ids, domain_in_use, is_domain_used};
use crate::{Caller, HostState, Providers, error_response, internal, json_response, now, validate, validate_query};

const STATUSES: [&str; 5] = ["active", "pending", "expired", "suspended", "cancelled"];

pub(crate) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<HostState>
where
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route("/dashboard", get(dashboard).route_layer(need("domains:read")))
        .route("/dashboard/chart", get(chart).route_layer(need("domains:read")))
        .route("/dashboard/recent", get(recent).route_layer(need("domains:read")))
        .route("/search", get(search).route_layer(need("domains:read")))
        .route("/check", post(check).route_layer(need("domains:read")))
        .route("/checkout", post(checkout).route_layer(need("domains:create")))
        .route(
            "/checkout/abandon",
            post(abandon).route_layer(need("domains:create")),
        )
        .route("/external", post(external).route_layer(need("domains:create")))
        .route("/", get(list).route_layer(need("domains:read")))
        .route("/", post(create).route_layer(need("domains:create")))
        .route("/{id}", get(detail).route_layer(need("domains:read")))
        .route("/{id}", patch(update).route_layer(need("domains:update")))
        .route(
            "/{id}",
            axum::routing::delete(remove).route_layer(need("domains:delete")),
        )
        .route(
            "/{id}/toggle-auto-renew",
            post(toggle_auto_renew).route_layer(need("domains:update")),
        )
        .route(
            "/{id}/toggle-privacy",
            post(toggle_privacy).route_layer(need("domains:update")),
        )
        .route(
            "/{id}/toggle-lock",
            post(toggle_lock).route_layer(need("domains:update")),
        )
        .route("/{id}/sync", post(sync).route_layer(need("domains:update")))
        .route("/{id}/renew", post(renew).route_layer(need("domains:update")))
        .route(
            "/{id}/verify-nameservers",
            post(verify_nameservers).route_layer(need("domains:update")),
        )
        .route(
            "/{id}/verify-ownership",
            post(verify_ownership).route_layer(need("domains:create")),
        )
        .route(
            "/{id}/refresh-zone-status",
            post(refresh_zone_status).route_layer(need("domains:read")),
        )
        .route(
            "/{id}/auth-code",
            post(auth_code).route_layer(need("domains:read")),
        )
        .route(
            "/registrations/{id}/status",
            get(registration_status).route_layer(need("domains:read")),
        )
        .route(
            "/registrations/{id}/complete",
            post(complete_registration).route_layer(need("domains:update")),
        )
}

/// `isListedDomainSql()`: unpaid checkout rows stay out of lists and counts.
macro_rules! listed {
    () => {
        "(t.registration_status is distinct from 'pending_payment' and not (t.status = 'cancelled' and t.registration_status is not distinct from 'failed'))"
    };
}

// ── Errors ──────────────────────────────────────────────────────────────────

/// What a registrar-backed route can fail with.
enum Failure {
    Rtr(RtrError),
    Cf(RegistrarError),
    Db(sqlx::Error),
    Other(String),
}

impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Rtr(error) => error.fmt(f),
            Self::Cf(error) => error.fmt(f),
            Self::Db(error) => error.fmt(f),
            Self::Other(message) => f.write_str(message),
        }
    }
}

impl From<sqlx::Error> for Failure {
    fn from(error: sqlx::Error) -> Self {
        Self::Db(error)
    }
}

impl From<RtrError> for Failure {
    fn from(error: RtrError) -> Self {
        Self::Rtr(error)
    }
}

impl From<RegistrarError> for Failure {
    fn from(error: RegistrarError) -> Self {
        Self::Cf(error)
    }
}

fn bad_gateway(code: &str, message: &str) -> Response {
    error_response(StatusCode::BAD_GATEWAY, code, message)
}

/// `registrarFailure(c, scope, err, fallback)`.
fn registrar_failure(scope: &str, failure: &Failure, fallback: &str) -> Response {
    tracing::error!(%failure, "[app-api/domains] {scope} failed");
    match failure {
        Failure::Rtr(error) => match error.status {
            401 | 403 => bad_gateway(
                "REGISTRAR_UNAUTHORIZED",
                "Realtime Register rejected our API credentials. Check REALTIME_REGISTER_API_KEY / CUSTOMER.",
            ),
            400 | 422 => ApiError::bad_request(error.message.clone()).into_response(),
            status => bad_gateway(
                "REGISTRAR_UNAVAILABLE",
                &format!("Realtime Register returned {status}"),
            ),
        },
        Failure::Cf(RegistrarError::Api { status, message }) => match status {
            401 | 403 => bad_gateway(
                "REGISTRAR_UNAUTHORIZED",
                "Cloudflare Registrar rejected our API credentials. CLOUDFLARE_API_TOKEN needs Registrar permissions on the configured account.",
            ),
            400 | 422 => ApiError::bad_request(message.clone()).into_response(),
            status => bad_gateway(
                "REGISTRAR_UNAVAILABLE",
                &format!("Cloudflare Registrar returned {status}"),
            ),
        },
        _ => ApiError::internal().with_message(fallback).into_response(),
    }
}

fn rtr_unconfigured() -> Response {
    error_response(
        StatusCode::SERVICE_UNAVAILABLE,
        "SERVICE_UNAVAILABLE",
        "Realtime Register is not configured",
    )
}

/// A statement outside the route's `try`: the app's 500.
fn app_error(error: &sqlx::Error) -> Response {
    tracing::error!(%error, "[host-api] domains");
    ApiError::internal().into_response()
}

fn domain_event(id: &str, row: &Value) -> Value {
    json!({ "id": id, "name": row["fullDomain"], "status": row["status"] })
}

// ── Dashboard ───────────────────────────────────────────────────────────────

async fn dashboard(caller: Caller) -> Response {
    let stats: Result<(i32, i32, i32, i32, i32, i32, i32), sqlx::Error> = sqlx::query_as(concat!(
        "select count(*)::int,
           count(*) filter (where t.status = 'active')::int,
           count(*) filter (where t.status = 'pending')::int,
           count(*) filter (where t.status = 'expired')::int,
           count(*) filter (where t.expires_at is not null and t.expires_at <= now() + interval '30 days')::int,
           count(*) filter (where t.ssl_enabled = true)::int,
           count(*) filter (where t.auto_renew = true)::int
         from domains t where t.deleted_at is null and ",
        listed!()
    ))
    .fetch_one(&caller.db)
    .await;
    match stats {
        Ok((total, active, pending, expired, expiring, ssl, auto_renew)) => Data(json!({
            "totalDomains": total,
            "activeDomains": active,
            "pendingDomains": pending,
            "expiredDomains": expired,
            "expiringSoon": expiring,
            "sslEnabled": ssl,
            "autoRenewEnabled": auto_renew,
        }))
        .into_response(),
        Err(error) => internal(&error, "Failed to fetch dashboard stats"),
    }
}

/// `Math.min(Math.max(Number.parseInt(raw ?? fallback, 10) || fallback, 1), max)`.
fn clamp_param(raw: Option<&str>, name: &str, fallback: i64, max: i64) -> i64 {
    let query = weldsuite_kit::validation::query_values(raw);
    let value = match query.get(name) {
        Some(Value::String(text)) => parse_int(text),
        Some(Value::Array(items)) => items.first().and_then(Value::as_str).and_then(parse_int),
        _ => Some(fallback),
    };
    value.filter(|v| *v != 0).unwrap_or(fallback).clamp(1, max)
}

fn day_of(stamp: &str) -> Option<String> {
    stamp.get(..10).map(str::to_owned)
}

async fn chart(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let days = clamp_param(raw.as_deref(), "days", 90, 365);
    let rows: Result<Vec<(Option<String>, Option<String>, Option<String>, String)>, sqlx::Error> =
        sqlx::query_as(concat!(
            "select to_jsonb(t.registered_at)#>>'{}', to_jsonb(t.renewed_at)#>>'{}',
               to_jsonb(t.expires_at)#>>'{}', t.status::text
             from domains t where t.deleted_at is null and ",
            listed!()
        ))
        .fetch_all(&caller.db)
        .await;
    let rows = match rows {
        Ok(rows) => rows,
        Err(error) => return internal(&error, "Failed to fetch chart data"),
    };
    let end = OffsetDateTime::now_utc();
    let mut points: Vec<(String, [i64; 3])> = Vec::new();
    let mut at = end - Duration::days(days);
    while at <= end {
        if let Some(day) = day_of(&iso_timestamp(at)) {
            points.push((day, [0, 0, 0]));
        }
        at += Duration::days(1);
    }
    let mut bump = |stamp: &Option<String>, field: usize| {
        if let Some(day) = stamp
            .as_deref()
            .and_then(weldsuite_db::js_timestamp)
            .and_then(|s| day_of(&s))
            && let Some(point) = points.iter_mut().find(|(d, _)| *d == day)
        {
            point.1[field] += 1;
        }
    };
    for (registered, renewed, expires, status) in &rows {
        bump(registered, 0);
        bump(renewed, 1);
        if status == "expired" {
            bump(expires, 2);
        }
    }
    points.sort_by(|a, b| a.0.cmp(&b.0));
    let data: Vec<Value> = points
        .into_iter()
        .map(|(date, [registrations, renewals, expirations])| {
            json!({ "date": date, "registrations": registrations, "renewals": renewals, "expirations": expirations })
        })
        .collect();
    Data(data).into_response()
}

async fn recent(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let limit = clamp_param(raw.as_deref(), "limit", 10, 100);
    let rows: Result<Vec<Value>, sqlx::Error> = sqlx::query_scalar(concat!(
        "select to_jsonb(t) from domains t where t.deleted_at is null and ",
        listed!(),
        " order by t.created_at desc limit $1"
    ))
    .bind(limit)
    .fetch_all(&caller.db)
    .await;
    match rows {
        Ok(rows) => Data(
            rows.into_iter()
                .map(|row| public_domain(weldsuite_db::js_row(row)))
                .collect::<Vec<_>>(),
        )
        .into_response(),
        Err(error) => internal(&error, "Failed to fetch recent domains"),
    }
}

// ── Pricing, search and availability ────────────────────────────────────────

/// One active `domain_pricing` row.
#[derive(Debug, Clone)]
struct Pricing {
    currency: Option<String>,
    registration_price: Option<String>,
    markup_amount: Option<i32>,
    markup_percent: Option<String>,
}

/// `loadPricingMap`: by normalised TLD, in row order (a later row for the
/// same TLD wins, keeping the first one's place).
async fn pricing_map(master: &PgPool) -> Result<Vec<(String, Pricing)>, sqlx::Error> {
    let rows: Vec<(String, Option<String>, Option<String>, Option<i32>, Option<String>)> =
        sqlx::query_as(
            "select tld, currency, registration_price::text, markup_amount, markup_percent::text
             from domain_pricing where is_active = true",
        )
        .fetch_all(master)
        .await?;
    let mut map: Vec<(String, Pricing)> = Vec::new();
    for (tld, currency, registration_price, markup_amount, markup_percent) in rows {
        let key = tld.strip_prefix('.').unwrap_or(&tld).to_lowercase();
        let pricing = Pricing {
            currency,
            registration_price,
            markup_amount,
            markup_percent,
        };
        if let Some(slot) = map.iter_mut().find(|(k, _)| *k == key) {
            slot.1 = pricing;
        } else {
            map.push((key, pricing));
        }
    }
    Ok(map)
}

fn pricing_of<'a>(map: &'a [(String, Pricing)], tld: &str) -> Option<&'a Pricing> {
    map.iter().find(|(k, _)| k == tld).map(|(_, p)| p)
}

/// `applyCatalogMarkup`.
fn catalog_markup(cents: f64, pricing: Option<&Pricing>) -> f64 {
    let Some(pricing) = pricing else {
        return cents;
    };
    if let Some(amount) = pricing.markup_amount {
        return cents + f64::from(amount);
    }
    if let Some(percent) = &pricing.markup_percent {
        let pct = parse_float(&json!(percent)).unwrap_or(f64::NAN);
        return round(cents * (1.0 + pct / 100.0));
    }
    cents
}

/// `applyMarkup(wholesaleCents, pricing, wholesaleCurrency)` for a
/// registration: `None` without a price.
fn apply_markup(wholesale: Option<f64>, pricing: Option<&Pricing>, currency: Option<&str>) -> Option<f64> {
    let pricing_currency = pricing
        .and_then(|p| p.currency.as_deref())
        .map(str::to_lowercase)
        .filter(|c| !c.is_empty());
    let wholesale_currency = currency.map(str::to_lowercase).filter(|c| !c.is_empty());
    let mismatch = matches!((&pricing_currency, &wholesale_currency), (Some(a), Some(b)) if a != b);
    let mut cents = wholesale.filter(|w| !mismatch && w.is_finite()).map(round);
    if cents.is_none()
        && let Some(price) = pricing.and_then(|p| p.registration_price.as_deref())
        && let Some(major) = parse_float(&json!(price)).filter(|m| m.is_finite())
    {
        cents = Some(round(major * 100.0));
    }
    cents.map(|cents| catalog_markup(cents, pricing))
}

/// `transformResult`.
fn transform(result: &CheckResult, map: &[(String, Pricing)]) -> Value {
    let tld = tld_of(&result.name);
    let pricing = pricing_of(map, &tld);
    let available = result.available && result.reason.as_deref() != Some("check_failed");
    let price = apply_markup(result.price_cents, pricing, result.currency.as_deref());
    let mut out = Map::new();
    out.insert("domain_name".to_owned(), json!(result.name));
    out.insert("suffix".to_owned(), json!(tld));
    out.insert("status".to_owned(), json!(if available { 1 } else { 2 }));
    out.insert("premium".to_owned(), json!(result.premium));
    out.insert(
        "price".to_owned(),
        price.filter(|p| p.is_finite()).map_or(Value::Null, number_json),
    );
    out.insert(
        "currency".to_owned(),
        json!(
            pricing
                .and_then(|p| p.currency.clone())
                .or_else(|| result.currency.clone())
                .unwrap_or_else(|| "USD".to_owned())
        ),
    );
    out.insert("domain".to_owned(), json!(result.name));
    out.insert("available".to_owned(), json!(available));
    if let Some(reason) = &result.reason {
        out.insert("reason".to_owned(), json!(reason));
    }
    Value::Object(out)
}

/// `oteSearchTlds`: the priced TLDs, the registrar's defaults first.
fn ote_search_tlds(map: &[(String, Pricing)]) -> Vec<String> {
    let mut out: Vec<String> = OTE_SEARCH_DEFAULT_TLDS
        .iter()
        .filter(|t| map.iter().any(|(k, _)| k == *t))
        .map(|t| (*t).to_owned())
        .collect();
    let mut rest: Vec<String> = map
        .iter()
        .map(|(k, _)| k.clone())
        .filter(|k| !OTE_SEARCH_DEFAULT_TLDS.contains(&k.as_str()))
        .collect();
    rest.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    out.extend(rest);
    out
}

/// The 503s of an unconfigured registrar; `Ok` with the client otherwise.
fn searchable(providers: &Providers) -> Result<RealtimeRegistrar, Response> {
    let Some(rtr) = providers.rtr.clone() else {
        return Err(rtr_unconfigured());
    };
    if !rtr.can_search() {
        return Err(error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "SERVICE_UNAVAILABLE",
            "Realtime Register ADAC is not configured",
        ));
    }
    Ok(rtr)
}

fn no_master() -> Failure {
    Failure::Other("no master database".to_owned())
}

async fn search(State(state): State<HostState>, caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let (q, limit) = match validate_query(raw.as_deref(), |issues, query| {
        let q = issues.text(query, "q", Presence::Required, Some(2), None).into_option();
        let limit = issues
            .number(
                query,
                "limit",
                Presence::Optional,
                Number {
                    coerce: true,
                    int: false,
                    min: Some(1.0),
                    max: Some(50.0),
                },
            )
            .into_option()
            .unwrap_or(20.0);
        (q.unwrap_or_default(), limit)
    }) {
        Ok(query) => query,
        Err(response) => return *response,
    };
    let rtr = match searchable(&caller.providers(&state)) {
        Ok(rtr) => rtr,
        Err(response) => return response,
    };
    let result: Result<Vec<Value>, Failure> = async {
        let master = caller.master(&state).ok_or_else(no_master)?;
        let limit = limit.min(50.0);
        if rtr.is_ote() {
            let map = pricing_map(&master).await?;
            let results = rtr.search_domains(&q, &ote_search_tlds(&map), limit).await?;
            return Ok(results.iter().map(|r| transform(r, &map)).collect());
        }
        let results = rtr.search_domains(&q, &[], 50.0).await?;
        let map = pricing_map(&master).await?;
        let priced: Vec<&CheckResult> = if map.is_empty() {
            results.iter().collect()
        } else {
            results
                .iter()
                .filter(|r| pricing_of(&map, &tld_of(&r.name)).is_some())
                .collect()
        };
        let chosen: Vec<&CheckResult> = if priced.is_empty() {
            results.iter().collect()
        } else {
            priced
        };
        Ok(chosen
            .into_iter()
            .take(js_slice_end(limit))
            .map(|r| transform(r, &map))
            .collect())
    }
    .await;
    match result {
        Ok(rows) => Data(rows).into_response(),
        Err(failure) => registrar_failure("search", &failure, "Domain search failed"),
    }
}

async fn check(
    State(state): State<HostState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let domains = match validate(&headers, &body, |issues, body| {
        issues
            .list(body, "domains", Presence::Required, Some(1), Some(20), |issues, item| {
                issues.item_text(item, Text::length(Some(1), None))
            })
            .into_option()
            .unwrap_or_default()
    }) {
        Ok(domains) => domains,
        Err(response) => return *response,
    };
    let rtr = match searchable(&caller.providers(&state)) {
        Ok(rtr) => rtr,
        Err(response) => return response,
    };
    let result: Result<Vec<Value>, Failure> = async {
        let master = caller.master(&state).ok_or_else(no_master)?;
        let results = rtr.check_domains(&domains).await;
        let map = pricing_map(&master).await?;
        Ok(results.iter().map(|r| transform(r, &map)).collect())
    }
    .await;
    match result {
        Ok(rows) => Data(rows).into_response(),
        Err(failure) => registrar_failure("check", &failure, "Domain availability check failed"),
    }
}

// ── Checkout ────────────────────────────────────────────────────────────────

/// `contactSchema`.
fn contact(issues: &mut Issues, fields: &Map<String, Value>) {
    let required = |issues: &mut Issues, key: &str| {
        let _ = issues.text(fields, key, Presence::Required, Some(1), None);
    };
    let optional = |issues: &mut Issues, key: &str| {
        let _ = issues.text(fields, key, Presence::Optional, None, None);
    };
    required(issues, "firstName");
    required(issues, "lastName");
    optional(issues, "organization");
    let _ = issues.text_with(
        fields,
        "email",
        Presence::Required,
        Text {
            format: Some(Format::Email),
            ..Text::default()
        },
    );
    required(issues, "phone");
    required(issues, "address1");
    optional(issues, "address2");
    required(issues, "city");
    optional(issues, "state");
    required(issues, "postalCode");
    match fields.get("country") {
        Some(Value::String(country)) => {
            let length = country.encode_utf16().count();
            if length != 2 {
                issues.string_length("country", 2, length);
            }
        }
        _ => {
            let _ = issues.text(fields, "country", Presence::Required, None, None);
        }
    }
}

/// `checkoutInput`, its `.refine()` included: a failed type check aborts
/// the object, and Zod then skips the refinement.
fn checkout_fields(issues: &mut Issues, body: &Map<String, Value>) {
    let before = issues.count();
    let domain = issues.text(body, "domain", Presence::Optional, Some(3), None);
    let domains = issues.list(body, "domains", Presence::Optional, Some(1), Some(10), |issues, item| {
        issues.item_text(item, Text::length(Some(3), None))
    });
    let _ = issues.nested(body, "contact", Presence::Optional, contact);
    let _ = issues.boolean(body, "autoRenew", Presence::Optional);
    let _ = issues.boolean(body, "privacyProtection", Presence::Optional);
    let _ = issues.number(
        body,
        "years",
        Presence::Optional,
        Number {
            coerce: true,
            int: true,
            min: Some(1.0),
            max: Some(1.0),
        },
    );
    let _ = issues.text(body, "stripePriceId", Presence::Nullish, None, None);
    let aborted = issues.issues_since(before).iter().any(|issue| {
        matches!(
            issue.get("code").and_then(Value::as_str),
            Some("invalid_type" | "invalid_enum_value" | "invalid_union" | "invalid_literal")
        )
    });
    if aborted {
        return;
    }
    // The refinement sees the parsed values, those that only failed a check
    // (a too-short name) included.
    let _ = (domain, domains);
    let has_domain = body
        .get("domain")
        .and_then(Value::as_str)
        .is_some_and(|d| !crate::js::js_trim(d).is_empty());
    let has_domains = body
        .get("domains")
        .and_then(Value::as_array)
        .is_some_and(|list| !list.is_empty());
    if !has_domain && !has_domains {
        issues.custom("domains", "Provide at least one domain");
    }
}

async fn checkout(
    State(state): State<HostState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if let Err(response) = validate(&headers, &body, checkout_fields) {
        return *response;
    }
    if caller.clerk_org_id.is_none() {
        return ApiError::org_required().into_response();
    }
    if caller.providers(&state).rtr.is_none() {
        return rtr_unconfigured();
    }
    // Stripe is Global's: this backend has no `STRIPE_SECRET_KEY`.
    ApiError::internal()
        .with_message("Stripe is not configured")
        .into_response()
}

async fn abandon(
    State(state): State<HostState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let ids = match validate(&headers, &body, |issues, body| {
        issues
            .list(body, "registrationIds", Presence::Required, Some(1), Some(20), |issues, item| {
                issues.item_text(item, Text::length(Some(1), None))
            })
            .into_option()
            .unwrap_or_default()
    }) {
        Ok(ids) => ids,
        Err(response) => return *response,
    };
    let result: Result<Vec<(String, String, String)>, sqlx::Error> = async {
        let rows: Vec<(String, String, String)> = sqlx::query_as(
            "select t.id, t.full_domain, t.status::text from domains t
             where t.deleted_at is null
               and (t.registration_status = 'pending_payment'
                    or (t.status = 'cancelled' and t.registration_status = 'failed'))
               and t.id = any($1)",
        )
        .bind(&ids)
        .fetch_all(&caller.db)
        .await?;
        if rows.is_empty() {
            return Ok(rows);
        }
        let deleted: Vec<String> = rows.iter().map(|(id, _, _)| id.clone()).collect();
        sqlx::query(
            "update domains set deleted_at = $2::timestamp, updated_at = $2::timestamp where id = any($1)",
        )
        .bind(&deleted)
        .bind(now())
        .execute(&caller.db)
        .await?;
        // No Stripe here: no checkout session to expire.
        Ok(rows)
    }
    .await;
    match result {
        Ok(rows) => {
            for (id, full_domain, status) in &rows {
                caller.publish(
                    &state,
                    DOMAIN_DELETED,
                    id,
                    &json!({ "id": id, "name": full_domain, "status": status }),
                );
            }
            Data(json!({ "abandoned": rows.len() })).into_response()
        }
        Err(error) => internal(&error, "Failed to abandon unpaid registration"),
    }
}

// ── External domains ────────────────────────────────────────────────────────

/// `/^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/`.
fn is_fqdn(text: &str) -> bool {
    if text.starts_with('-') {
        return false;
    }
    let labels: Vec<&str> = text.split('.').collect();
    labels.len() >= 2
        && labels.iter().all(|label| {
            !label.is_empty()
                && label
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        })
}

async fn external(
    State(state): State<HostState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match validate(&headers, &body, |issues, body| {
        let domain = issues.text_with(
            body,
            "domain",
            Presence::Required,
            Text {
                trim: true,
                lowercase: true,
                format: None,
                min: Some(3),
                max: Some(253),
            },
        );
        let mut domain = domain.into_option();
        if let Some(Value::String(raw)) = body.get("domain") {
            let transformed = crate::js::js_trim(raw).to_lowercase();
            if !is_fqdn(&transformed) {
                issues.issue_at(
                    "domain",
                    json!({
                        "validation": "regex",
                        "code": "invalid_string",
                        "message": "Enter a valid fully-qualified domain name (e.g. example.com)",
                    }),
                );
                domain = None;
            }
        }
        let registrar = issues
            .text(body, "registrar", Presence::Optional, None, Some(255))
            .into_option();
        (domain.unwrap_or_default(), registrar)
    }) {
        Ok(input) => input,
        Err(response) => return *response,
    };
    let (domain, registrar) = input;
    let result: Result<Response, sqlx::Error> = async {
        let existing: Option<String> = sqlx::query_scalar(
            "select t.status::text from domains t where t.full_domain = $1 and t.deleted_at is null limit 1",
        )
        .bind(&domain)
        .fetch_optional(&caller.db)
        .await?;
        if existing.is_some_and(|status| status != "cancelled") {
            return Ok(ApiError::conflict("This domain is already being managed in your workspace.")
                .into_response());
        }
        let parts: Vec<&str> = domain.split('.').collect();
        let name = parts.first().copied().filter(|p| !p.is_empty()).unwrap_or(&domain);
        let tld = parts.get(1..).map(|p| p.join(".")).unwrap_or_default();
        let tld = if tld.is_empty() { "com".to_owned() } else { tld };
        let id = generate_id("dom");
        let token = random_uuid_hex();
        sqlx::query(
            "insert into domains (id, name, tld, full_domain, status, registrar, custom_nameservers,
               nameserver_verified, nameserver_verification_pending, nameserver_verification_token)
             values ($1, $2, $3, $4, 'pending', $5, false, false, true, $6)",
        )
        .bind(&id)
        .bind(name)
        .bind(&tld)
        .bind(&domain)
        .bind(registrar.filter(|r| !r.is_empty()).unwrap_or_else(|| "External".to_owned()))
        .bind(&token)
        .execute(&caller.db)
        .await?;
        let row = any_domain(&caller.db, &id).await?.unwrap_or(Value::Null);
        caller.publish(&state, DOMAIN_USE_EXTERNAL, &id, &domain_event(&id, &row));
        let mut body = public_domain(row);
        body["verificationRecord"] = json!({
            "name": format!("_weldhost-verify.{domain}"),
            "type": "TXT",
            "value": format!("weldhost-verify={token}"),
        });
        Ok(Created(body).into_response())
    }
    .await;
    result.unwrap_or_else(|error| internal(&error, "Failed to add external domain"))
}

// ── List, read, create, update, delete ──────────────────────────────────────

macro_rules! list_sql {
    ($column:literal, $dir:literal) => {
        concat!(
            "select to_jsonb(t) from domains t where t.deleted_at is null and ",
            listed!(),
            " and ($1::boolean or (t.full_domain like $2 or t.name like $2))",
            " and ($3::boolean or t.status = $4::host_domain_status)",
            " order by t.", $column, " ", $dir, " limit $5 offset $6"
        )
    };
}

fn list_statement(sort_by: Option<&str>, ascending: bool) -> &'static str {
    match (sort_by, ascending) {
        (Some("fullDomain"), true) => list_sql!("full_domain", "asc"),
        (Some("fullDomain"), false) => list_sql!("full_domain", "desc"),
        (Some("status"), true) => list_sql!("status", "asc"),
        (Some("status"), false) => list_sql!("status", "desc"),
        (Some("expiresAt"), true) => list_sql!("expires_at", "asc"),
        (Some("expiresAt"), false) => list_sql!("expires_at", "desc"),
        (_, true) => list_sql!("created_at", "asc"),
        (_, false) => list_sql!("created_at", "desc"),
    }
}

/// The query of `GET /`.
struct ListQuery {
    page: i64,
    page_size: i64,
    search: Option<String>,
    status: Option<String>,
    sort_by: Option<String>,
    ascending: bool,
}

fn read_list_query(issues: &mut Issues, q: &Map<String, Value>) -> ListQuery {
    let int = |min: f64, max: Option<f64>| Number {
        coerce: true,
        int: true,
        min: Some(min),
        max,
    };
    let page = issues
        .whole_number(q, "page", Presence::Optional, int(1.0, None))
        .into_option()
        .unwrap_or(1);
    let page_size = issues
        .whole_number(q, "pageSize", Presence::Optional, int(1.0, Some(100.0)))
        .into_option()
        .unwrap_or(20);
    let search = issues.text(q, "search", Presence::Optional, None, None).into_option();
    let status = issues
        .choice(
            q,
            "status",
            Presence::Optional,
            &["all", "active", "pending", "expired", "suspended", "cancelled"],
        )
        .into_option();
    let sort_by = issues
        .choice(
            q,
            "sortBy",
            Presence::Optional,
            &["fullDomain", "status", "expiresAt", "createdAt"],
        )
        .into_option();
    let sort_order = issues
        .choice(q, "sortOrder", Presence::Optional, &["asc", "desc"])
        .into_option();
    let _ = issues.text(q, "cursor", Presence::Optional, None, None);
    let _ = issues.whole_number(q, "limit", Presence::Optional, int(1.0, Some(100.0)));
    ListQuery {
        page,
        page_size,
        search,
        status,
        sort_by,
        ascending: sort_order.as_deref() == Some("asc"),
    }
}

async fn list(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let query = match validate_query(raw.as_deref(), read_list_query) {
        Ok(query) => query,
        Err(response) => return *response,
    };
    let result: Result<Value, sqlx::Error> = async {
        let page_size = query.page_size.min(100);
        let search = query.search.filter(|s| !s.is_empty()).map(|s| format!("%{s}%"));
        let status = query.status.filter(|s| !s.is_empty() && s != "all");
        let total: i32 = sqlx::query_scalar(concat!(
            "select count(*)::int from domains t where t.deleted_at is null and ",
            listed!(),
            " and ($1::boolean or (t.full_domain like $2 or t.name like $2))",
            " and ($3::boolean or t.status = $4::host_domain_status)"
        ))
        .bind(search.is_none())
        .bind(search.clone())
        .bind(status.is_none())
        .bind(status.clone())
        .fetch_one(&caller.db)
        .await?;
        let rows: Vec<Value> = sqlx::query_scalar(list_statement(query.sort_by.as_deref(), query.ascending))
            .bind(search.is_none())
            .bind(search)
            .bind(status.is_none())
            .bind(status)
            .bind(page_size)
            .bind((query.page - 1) * page_size)
            .fetch_all(&caller.db)
            .await?;
        let (all, active, pending, expired): (i32, i32, i32, i32) = sqlx::query_as(concat!(
            "select count(*)::int,
               count(*) filter (where t.status = 'active')::int,
               count(*) filter (where t.status = 'pending')::int,
               count(*) filter (where t.status = 'expired')::int
             from domains t where t.deleted_at is null and ",
            listed!()
        ))
        .fetch_one(&caller.db)
        .await?;
        let domains: Vec<Value> = rows
            .into_iter()
            .map(|row| public_domain(weldsuite_db::js_row(row)))
            .collect();
        let ids: Vec<String> = domains
            .iter()
            .filter_map(|d| text(d, "id").map(str::to_owned))
            .collect();
        let connected = connected_domain_ids(&caller.db, &ids).await?;
        let domains: Vec<Value> = domains
            .into_iter()
            .map(|mut domain| {
                let used = text(&domain, "id").is_some_and(|id| connected.iter().any(|c| c == id));
                domain["usedByWeldReach"] = json!(used);
                domain
            })
            .collect();
        let total_pages = ((f64::from(total) / page_size as f64).ceil() as i64).max(1);
        Ok(json!({
            "domains": domains,
            "pagination": {
                "page": query.page,
                "pageSize": page_size,
                "total": total,
                "totalPages": total_pages,
            },
            "stats": { "total": all, "active": active, "pending": pending, "expired": expired },
        }))
    }
    .await;
    match result {
        Ok(body) => json_response(StatusCode::OK, body),
        Err(error) => internal(&error, "Failed to fetch domains"),
    }
}

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    let result: Result<Response, sqlx::Error> = async {
        let Some((domain, zone)) = domain_with_zone(&caller.db, &id).await? else {
            return Ok(ApiError::not_found("Domain", Some(&id)).into_response());
        };
        if is_hidden_unpaid(&domain) {
            return Ok(ApiError::not_found("Domain", Some(&id)).into_response());
        }
        let mut body = public_domain(domain);
        body["dnsZone"] = zone.unwrap_or(Value::Null);
        body["usedByWeldReach"] = json!(is_domain_used(&caller.db, &id).await?);
        Ok(Data(body).into_response())
    }
    .await;
    result.unwrap_or_else(|error| internal(&error, "Failed to fetch domain"))
}

async fn create(
    State(state): State<HostState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let input = match validate(&headers, &body, |issues, body| {
        let mut out = Map::new();
        for (key, max) in [("name", 255), ("tld", 50), ("fullDomain", 255)] {
            if let Field::Set(value) = issues.text(body, key, Presence::Required, Some(1), Some(max)) {
                out.insert(key.to_owned(), json!(value));
            }
        }
        let status = issues
            .choice(body, "status", Presence::Optional, &STATUSES)
            .into_option()
            .unwrap_or_else(|| "pending".to_owned());
        out.insert("status".to_owned(), json!(status));
        if let Field::Set(registrar) = issues.text(body, "registrar", Presence::Optional, None, Some(255)) {
            out.insert("registrar".to_owned(), json!(registrar));
        }
        if let Field::Set(nameservers) = issues.list(body, "nameservers", Presence::Optional, None, None, |issues, item| {
            issues.item_text(item, Text::default())
        }) {
            out.insert("nameservers".to_owned(), json!(nameservers));
        }
        for (key, default) in [
            ("customNameservers", false),
            ("autoRenew", true),
            ("privacyProtection", false),
            ("locked", true),
        ] {
            let flag = issues.boolean(body, key, Presence::Optional).into_option().unwrap_or(default);
            out.insert(key.to_owned(), json!(flag));
        }
        if let Field::Set(notes) = issues.text(body, "notes", Presence::Optional, None, None) {
            out.insert("notes".to_owned(), json!(notes));
        }
        out
    }) {
        Ok(input) => input,
        Err(response) => return *response,
    };
    let id = generate_id("dom");
    let text_of = |key: &str| input.get(key).and_then(Value::as_str).map(str::to_owned);
    let flag = |key: &str| input.get(key).and_then(Value::as_bool);
    let result: Result<Response, sqlx::Error> = async {
        sqlx::query(
            "insert into domains (id, name, tld, full_domain, status, registrar, nameservers,
               custom_nameservers, auto_renew, privacy_protection, locked, notes)
             values ($1, $2, $3, $4, $5::host_domain_status, $6, $7, $8, $9, $10, $11, $12)",
        )
        .bind(&id)
        .bind(text_of("name"))
        .bind(text_of("tld"))
        .bind(text_of("fullDomain"))
        .bind(text_of("status"))
        .bind(text_of("registrar"))
        .bind(input.get("nameservers").cloned())
        .bind(flag("customNameservers"))
        .bind(flag("autoRenew"))
        .bind(flag("privacyProtection"))
        .bind(flag("locked"))
        .bind(text_of("notes"))
        .execute(&caller.db)
        .await?;
        let row = any_domain(&caller.db, &id).await?.unwrap_or(Value::Null);
        caller.publish(&state, DOMAIN_CREATED, &id, &domain_event(&id, &row));
        Ok(Created(public_domain(row)).into_response())
    }
    .await;
    result.unwrap_or_else(|error| internal(&error, "Failed to create domain"))
}

/// `updateDomainSchema`'s fields, in its order: (key, column, kind).
const UPDATE_FIELDS: [(&str, &str); 28] = [
    ("name", "text"),
    ("tld", "text"),
    ("fullDomain", "text"),
    ("status", "status"),
    ("registrar", "text"),
    ("externalRegistrarId", "nullish"),
    ("registrarStatus", "text"),
    ("registrarSyncedAt", "date"),
    ("registeredAt", "date"),
    ("expiresAt", "date"),
    ("renewedAt", "date"),
    ("nameservers", "list"),
    ("customNameservers", "bool"),
    ("nameserverVerified", "bool"),
    ("nameserverVerificationPending", "bool"),
    ("autoRenew", "bool"),
    ("privacyProtection", "bool"),
    ("locked", "bool"),
    ("sslEnabled", "bool"),
    ("emailForwardingEnabled", "bool"),
    ("authCode", "text"),
    ("authCodeExpiresAt", "date"),
    ("registrantContact", "record"),
    ("adminContact", "record"),
    ("techContact", "record"),
    ("billingContact", "record"),
    ("notes", "text"),
    ("metadata", "record"),
];

fn update_fields(issues: &mut Issues, body: &Map<String, Value>) -> Map<String, Value> {
    let mut out = Map::new();
    for (key, kind) in UPDATE_FIELDS {
        let max = match key {
            "name" | "fullDomain" | "registrar" | "externalRegistrarId" | "authCode" => Some(255),
            "tld" => Some(50),
            "registrarStatus" => Some(100),
            _ => None,
        };
        let min = matches!(key, "name" | "tld" | "fullDomain").then_some(1);
        let value = match kind {
            "text" => issues.text(body, key, Presence::Optional, min, max).into_option().map(Value::from),
            "nullish" => match issues.text(body, key, Presence::Nullish, None, max) {
                Field::Set(v) => Some(Value::from(v)),
                Field::Null => Some(Value::Null),
                Field::Absent => None,
            },
            "status" => issues.choice(body, key, Presence::Optional, &STATUSES).into_option().map(Value::from),
            "date" => issues
                .text_with(
                    body,
                    key,
                    Presence::Optional,
                    Text {
                        format: Some(Format::Datetime),
                        ..Text::default()
                    },
                )
                .into_option()
                .map(Value::from),
            "list" => issues
                .list(body, key, Presence::Optional, None, None, |issues, item| {
                    issues.item_text(item, Text::default())
                })
                .into_option()
                .map(|items| json!(items)),
            "bool" => issues.boolean(body, key, Presence::Optional).into_option().map(Value::from),
            _ => issues
                .nested(body, key, Presence::Optional, |_, fields| Value::Object(fields.clone()))
                .into_option(),
        };
        if let Some(value) = value {
            out.insert(key.to_owned(), value);
        }
    }
    out
}

/// `updateDomain(db, id, data)`: every given field, dates through
/// `new Date()`; `Ok(None)` for no live domain.
async fn write_update(db: &PgPool, id: &str, data: &Map<String, Value>) -> Result<Option<Value>, Failure> {
    if live_domain(db, id).await?.is_none() {
        return Ok(None);
    }
    let set = |key: &str| data.contains_key(key);
    let text = |key: &str| data.get(key).and_then(Value::as_str).map(str::to_owned);
    let date = |key: &str| -> Result<Option<String>, Failure> {
        match data.get(key).and_then(Value::as_str) {
            None => Ok(None),
            Some(raw) => js_date_iso(raw)
                .map(Some)
                .ok_or_else(|| Failure::Other("RangeError: Invalid time value".to_owned())),
        }
    };
    let flag = |key: &str| data.get(key).and_then(Value::as_bool);
    let json_of = |key: &str| data.get(key).cloned().filter(|v| !v.is_null());
    sqlx::query(
        "update domains set
           name = case when $2 then $3 else name end,
           tld = case when $4 then $5 else tld end,
           full_domain = case when $6 then $7 else full_domain end,
           status = case when $8 then $9::host_domain_status else status end,
           registrar = case when $10 then $11 else registrar end,
           external_registrar_id = case when $12 then $13 else external_registrar_id end,
           registrar_status = case when $14 then $15 else registrar_status end,
           registrar_synced_at = case when $16 then $17::timestamp else registrar_synced_at end,
           registered_at = case when $18 then $19::timestamp else registered_at end,
           expires_at = case when $20 then $21::timestamp else expires_at end,
           renewed_at = case when $22 then $23::timestamp else renewed_at end,
           nameservers = case when $24 then $25 else nameservers end,
           custom_nameservers = case when $26 then $27 else custom_nameservers end,
           nameserver_verified = case when $28 then $29 else nameserver_verified end,
           nameserver_verification_pending = case when $30 then $31 else nameserver_verification_pending end,
           auto_renew = case when $32 then $33 else auto_renew end,
           privacy_protection = case when $34 then $35 else privacy_protection end,
           locked = case when $36 then $37 else locked end,
           ssl_enabled = case when $38 then $39 else ssl_enabled end,
           email_forwarding_enabled = case when $40 then $41 else email_forwarding_enabled end,
           auth_code = case when $42 then $43 else auth_code end,
           auth_code_expires_at = case when $44 then $45::timestamp else auth_code_expires_at end,
           registrant_contact = case when $46 then $47 else registrant_contact end,
           admin_contact = case when $48 then $49 else admin_contact end,
           tech_contact = case when $50 then $51 else tech_contact end,
           billing_contact = case when $52 then $53 else billing_contact end,
           notes = case when $54 then $55 else notes end,
           metadata = case when $56 then $57 else metadata end,
           updated_at = $58::timestamp
         where id = $1",
    )
    .bind(id)
    .bind(set("name"))
    .bind(text("name"))
    .bind(set("tld"))
    .bind(text("tld"))
    .bind(set("fullDomain"))
    .bind(text("fullDomain"))
    .bind(set("status"))
    .bind(text("status"))
    .bind(set("registrar"))
    .bind(text("registrar"))
    .bind(set("externalRegistrarId"))
    .bind(text("externalRegistrarId"))
    .bind(set("registrarStatus"))
    .bind(text("registrarStatus"))
    .bind(set("registrarSyncedAt"))
    .bind(date("registrarSyncedAt")?)
    .bind(set("registeredAt"))
    .bind(date("registeredAt")?)
    .bind(set("expiresAt"))
    .bind(date("expiresAt")?)
    .bind(set("renewedAt"))
    .bind(date("renewedAt")?)
    .bind(set("nameservers"))
    .bind(json_of("nameservers"))
    .bind(set("customNameservers"))
    .bind(flag("customNameservers"))
    .bind(set("nameserverVerified"))
    .bind(flag("nameserverVerified"))
    .bind(set("nameserverVerificationPending"))
    .bind(flag("nameserverVerificationPending"))
    .bind(set("autoRenew"))
    .bind(flag("autoRenew"))
    .bind(set("privacyProtection"))
    .bind(flag("privacyProtection"))
    .bind(set("locked"))
    .bind(flag("locked"))
    .bind(set("sslEnabled"))
    .bind(flag("sslEnabled"))
    .bind(set("emailForwardingEnabled"))
    .bind(flag("emailForwardingEnabled"))
    .bind(set("authCode"))
    .bind(text("authCode"))
    .bind(set("authCodeExpiresAt"))
    .bind(date("authCodeExpiresAt")?)
    .bind(set("registrantContact"))
    .bind(json_of("registrantContact"))
    .bind(set("adminContact"))
    .bind(json_of("adminContact"))
    .bind(set("techContact"))
    .bind(json_of("techContact"))
    .bind(set("billingContact"))
    .bind(json_of("billingContact"))
    .bind(set("notes"))
    .bind(text("notes"))
    .bind(set("metadata"))
    .bind(json_of("metadata"))
    .bind(now())
    .execute(db)
    .await?;
    Ok(any_domain(db, id).await?)
}

async fn update(
    State(state): State<HostState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, update_fields) {
        Ok(data) => data,
        Err(response) => return *response,
    };
    let result: Result<Response, Failure> = async {
        if (data.contains_key("nameservers") || data.contains_key("customNameservers"))
            && let Some(existing) = live_domain(&caller.db, &id).await?
            && changes_nameservers(&existing, &data)
            && is_domain_used(&caller.db, &id).await?
        {
            return Ok(domain_in_use());
        }
        let Some(row) = write_update(&caller.db, &id, &data).await? else {
            return Ok(ApiError::not_found("Domain", Some(&id)).into_response());
        };
        caller.publish(&state, DOMAIN_UPDATED, &id, &domain_event(&id, &row));
        Ok(Data(public_domain(row)).into_response())
    }
    .await;
    result.unwrap_or_else(|failure| internal(&failure, "Failed to update domain"))
}

async fn remove(State(state): State<HostState>, caller: Caller, Path(id): Path<String>) -> Response {
    let result: Result<Response, sqlx::Error> = async {
        if is_domain_used(&caller.db, &id).await? {
            return Ok(domain_in_use());
        }
        let Some(existing) = live_domain(&caller.db, &id).await? else {
            return Ok(ApiError::not_found("Domain", Some(&id)).into_response());
        };
        sqlx::query(
            "update domains set deleted_at = $2::timestamp, updated_at = $2::timestamp where id = $1",
        )
        .bind(&id)
        .bind(now())
        .execute(&caller.db)
        .await?;
        caller.publish(&state, DOMAIN_DELETED, &id, &domain_event(&id, &existing));
        Ok(NoContent.into_response())
    }
    .await;
    result.unwrap_or_else(|error| internal(&error, "Failed to delete domain"))
}

// ── Registrar toggles and sync ──────────────────────────────────────────────

/// `{ enabled }` / `{ locked }`.
fn flag_body(headers: &HeaderMap, body: &Bytes, key: &str) -> Result<bool, Box<Response>> {
    validate(headers, body, |issues, body| {
        issues.boolean(body, key, Presence::Required).into_option().unwrap_or_default()
    })
}

/// The registrar a domain row is on, when it has an id there.
fn registered_at(domain: &Value) -> Option<&str> {
    text(domain, "externalRegistrarId")
        .filter(|id| !id.is_empty())
        .and(text(domain, "registrar"))
}

/// `update domains t set <column> = $2 … returning to_jsonb(t)`.
async fn set_flag(db: &PgPool, id: &str, sql: &'static str, value: bool) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(sql)
        .bind(id)
        .bind(value)
        .bind(now())
        .fetch_optional(db)
        .await?;
    Ok(row.map(weldsuite_db::js_row))
}

fn toggled(state: &HostState, caller: &Caller, id: &str, updated: Option<Value>) -> Response {
    let Some(updated) = updated else {
        return ApiError::not_found("Domain", Some(id)).into_response();
    };
    caller.publish(state, DOMAIN_UPDATED, id, &domain_event(id, &updated));
    Data(public_domain(updated)).into_response()
}

async fn toggle_auto_renew(
    State(state): State<HostState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let enabled = match flag_body(&headers, &body, "enabled") {
        Ok(enabled) => enabled,
        Err(response) => return *response,
    };
    // No Stripe here: there is no renewal invoice to void.
    let providers = caller.providers(&state);
    let result: Result<Option<Value>, Failure> = async {
        let Some(domain) = live_domain(&caller.db, &id).await? else {
            return Ok(None);
        };
        let full = text(&domain, "fullDomain").unwrap_or_default();
        match registered_at(&domain) {
            Some("realtimeregister") => {
                let rtr = providers
                    .rtr
                    .as_ref()
                    .ok_or_else(|| Failure::Other("Realtime Register is not configured".to_owned()))?;
                rtr.update_domain(full, &json!({ "autoRenew": false })).await?;
            }
            Some("cloudflare") => {
                let cf = providers
                    .cf_registrar()
                    .ok_or_else(|| Failure::Other("Cloudflare Registrar is not configured".to_owned()))?;
                cf.update_domain(full, Some(enabled), None).await?;
            }
            _ => {}
        }
        Ok(set_flag(
            &caller.db,
            &id,
            "update domains t set auto_renew = $2, updated_at = $3::timestamp where t.id = $1 returning to_jsonb(t)",
            enabled,
        )
        .await?)
    }
    .await;
    match result {
        Ok(updated) => toggled(&state, &caller, &id, updated),
        Err(failure) => registrar_failure("toggle-auto-renew", &failure, "Failed to toggle auto-renew"),
    }
}

async fn toggle_privacy(
    State(state): State<HostState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let enabled = match flag_body(&headers, &body, "enabled") {
        Ok(enabled) => enabled,
        Err(response) => return *response,
    };
    let providers = caller.providers(&state);
    let result: Result<Option<Value>, Failure> = async {
        let Some(domain) = live_domain(&caller.db, &id).await? else {
            return Ok(None);
        };
        let full = text(&domain, "fullDomain").unwrap_or_default();
        match registered_at(&domain) {
            Some("realtimeregister") => {
                let rtr = providers
                    .rtr
                    .as_ref()
                    .ok_or_else(|| Failure::Other("Realtime Register is not configured".to_owned()))?;
                if enabled && !tld_supports_privacy_protect(full) {
                    return Err(Failure::Other(
                        "Privacy protection is not supported for this TLD".to_owned(),
                    ));
                }
                rtr.update_domain(full, &json!({ "privacyProtect": enabled })).await?;
            }
            Some("cloudflare") => {
                return Err(Failure::Other(
                    "Privacy protection cannot be changed for domains registered through Cloudflare Registrar"
                        .to_owned(),
                ));
            }
            _ => {}
        }
        Ok(set_flag(
            &caller.db,
            &id,
            "update domains t set privacy_protection = $2, updated_at = $3::timestamp where t.id = $1 returning to_jsonb(t)",
            enabled,
        )
        .await?)
    }
    .await;
    match result {
        Ok(updated) => toggled(&state, &caller, &id, updated),
        Err(failure) => registrar_failure(
            "toggle-privacy",
            &failure,
            "Failed to toggle privacy protection",
        ),
    }
}

async fn toggle_lock(
    State(state): State<HostState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let locked = match flag_body(&headers, &body, "locked") {
        Ok(locked) => locked,
        Err(response) => return *response,
    };
    let providers = caller.providers(&state);
    let result: Result<Option<Value>, Failure> = async {
        let Some(domain) = live_domain(&caller.db, &id).await? else {
            return Ok(None);
        };
        let full = text(&domain, "fullDomain").unwrap_or_default();
        match registered_at(&domain) {
            Some("realtimeregister") => {
                let rtr = providers
                    .rtr
                    .as_ref()
                    .ok_or_else(|| Failure::Other("Realtime Register is not configured".to_owned()))?;
                rtr.set_transfer_lock(full, locked).await?;
            }
            Some("cloudflare") => {
                let cf = providers
                    .cf_registrar()
                    .ok_or_else(|| Failure::Other("Cloudflare Registrar is not configured".to_owned()))?;
                cf.update_domain(full, None, Some(locked)).await?;
            }
            _ => {}
        }
        Ok(set_flag(
            &caller.db,
            &id,
            "update domains t set locked = $2, updated_at = $3::timestamp where t.id = $1 returning to_jsonb(t)",
            locked,
        )
        .await?)
    }
    .await;
    match result {
        Ok(updated) => toggled(&state, &caller, &id, updated),
        Err(failure) => registrar_failure("toggle-lock", &failure, "Failed to toggle transfer lock"),
    }
}

/// Registration statuses during which a sync must not mark the domain registered.
const IN_FLIGHT: [&str; 5] = [
    "pending_payment",
    "pending_registration",
    "pending_workflow",
    "pending_transfer",
    "pending_renewal",
];

/// `new Date(text)` as written: `Err` for an Invalid Date.
fn date_or_fail(text: &str) -> Result<String, Failure> {
    js_date_iso(text).ok_or_else(|| Failure::Other("RangeError: Invalid time value".to_owned()))
}

/// `syncDomainStatus`.
async fn sync_status(db: &PgPool, providers: &Providers, id: &str) -> Result<Option<Value>, Failure> {
    let Some(domain) = live_domain(db, id).await? else {
        return Ok(None);
    };
    let can_mark = !text(&domain, "registrationStatus").is_some_and(|s| IN_FLIGHT.contains(&s));
    let full = text(&domain, "fullDomain").unwrap_or_default().to_owned();
    let registrar = text(&domain, "registrar");
    if registrar == Some("realtimeregister")
        && let Some(rtr) = &providers.rtr
    {
        let remote = rtr.get_domain(&full).await?;
        let expires = remote
            .expires_at
            .as_deref()
            .filter(|e| !e.is_empty())
            .map(date_or_fail)
            .transpose()?;
        let ok = remote.status.iter().any(|s| s == "OK" || s == "ok");
        let row: Option<Value> = sqlx::query_scalar(
            "update domains t set external_registrar_id = $2, registrar_status = $3, locked = $4,
               privacy_protection = $5,
               expires_at = case when $6 then $7::timestamp else expires_at end,
               auth_code = coalesce($8, auth_code),
               status = case when $9 then 'active'::host_domain_status else status end,
               registration_status = case when $10 then 'registered'::host_domain_registration_status else registration_status end,
               registrar_synced_at = $11::timestamp, updated_at = $11::timestamp
             where t.id = $1 returning to_jsonb(t)",
        )
        .bind(id)
        .bind(&remote.id)
        .bind(remote.status.join(","))
        .bind(remote.locked)
        .bind(remote.privacy_protect)
        .bind(expires.is_some())
        .bind(expires)
        .bind(remote.auth_code.clone())
        .bind(ok)
        .bind(can_mark)
        .bind(now())
        .fetch_optional(db)
        .await?;
        return Ok(row.map(weldsuite_db::js_row));
    }
    if registrar == Some("cloudflare")
        && let Some(cf) = providers.cf_registrar()
    {
        let remote = cf.get_domain(&full).await?;
        let expires = remote
            .expires_at
            .as_deref()
            .filter(|e| !e.is_empty())
            .map(date_or_fail)
            .transpose()?;
        let row: Option<Value> = sqlx::query_scalar(
            "update domains t set external_registrar_id = $2, registrar_status = $3, locked = $4,
               auto_renew = $5,
               expires_at = case when $6 then $7::timestamp else expires_at end,
               status = case when $8 then 'active'::host_domain_status else status end,
               registration_status = case when $9 then 'registered'::host_domain_registration_status else registration_status end,
               registrar_synced_at = $10::timestamp, updated_at = $10::timestamp
             where t.id = $1 returning to_jsonb(t)",
        )
        .bind(id)
        .bind(&remote.id)
        .bind((!remote.status.is_null()).then(|| as_text(&remote.status)))
        .bind(remote.locked.as_bool())
        .bind(remote.auto_renew.as_bool())
        .bind(expires.is_some())
        .bind(expires)
        .bind(remote.status.as_str() == Some("active"))
        .bind(can_mark)
        .bind(now())
        .fetch_optional(db)
        .await?;
        return Ok(row.map(weldsuite_db::js_row));
    }
    Ok(Some(domain))
}

async fn sync(State(state): State<HostState>, caller: Caller, Path(id): Path<String>) -> Response {
    let providers = caller.providers(&state);
    if providers.rtr.is_none() && providers.cf_registrar().is_none() {
        let found = async {
            if live_domain(&caller.db, &id).await?.is_none() {
                return Ok::<_, sqlx::Error>(false);
            }
            sqlx::query(
                "update domains set registrar_synced_at = $2::timestamp, updated_at = $3::timestamp where id = $1",
            )
            .bind(&id)
            .bind(now())
            .bind(now())
            .execute(&caller.db)
            .await?;
            Ok(true)
        }
        .await;
        return match found {
            Ok(true) => Data(json!({ "id": id, "syncedAt": now() })).into_response(),
            Ok(false) => ApiError::not_found("Domain", Some(&id)).into_response(),
            Err(error) => app_error(&error),
        };
    }
    match sync_status(&caller.db, &providers, &id).await {
        Ok(Some(updated)) => {
            caller.publish(&state, DOMAIN_UPDATED, &id, &domain_event(&id, &updated));
            Data(public_domain(updated)).into_response()
        }
        Ok(None) => ApiError::not_found("Domain", Some(&id)).into_response(),
        Err(failure) => internal(&failure, "Domain sync failed"),
    }
}

async fn renew(State(state): State<HostState>, caller: Caller, Path(id): Path<String>) -> Response {
    if caller.clerk_org_id.is_none() {
        return ApiError::org_required().into_response();
    }
    let providers = caller.providers(&state);
    let existing = match live_domain(&caller.db, &id).await {
        Ok(existing) => existing,
        Err(error) => return app_error(&error),
    };
    let Some(existing) = existing else {
        return ApiError::not_found("Domain", Some(&id)).into_response();
    };
    match text(&existing, "registrar") {
        Some("cloudflare") => {
            return ApiError::bad_request(
                "Renewal is not available via API for domains registered through Cloudflare Registrar",
            )
            .into_response();
        }
        Some("realtimeregister") if providers.rtr.is_none() => return rtr_unconfigured(),
        _ => {}
    }
    // Stripe is Global's: this backend has no `STRIPE_SECRET_KEY`.
    ApiError::internal()
        .with_message("Stripe is not configured")
        .into_response()
}

// ── Nameservers, ownership and the zone ─────────────────────────────────────

const REQUIRED_NAMESERVERS: [&str; 4] = [
    "ns1.weldhost.com",
    "ns2.weldhost.com",
    "ns3.weldhost.com",
    "ns4.weldhost.com",
];

async fn verify_nameservers(caller: Caller, Path(id): Path<String>) -> Response {
    let result: Result<Option<Value>, sqlx::Error> = async {
        let Some(domain) = live_domain(&caller.db, &id).await? else {
            return Ok(None);
        };
        sqlx::query(
            "update domains set nameserver_verification_pending = true, updated_at = $2::timestamp where id = $1",
        )
        .bind(&id)
        .bind(now())
        .execute(&caller.db)
        .await?;
        Ok(Some(domain))
    }
    .await;
    match result {
        Ok(Some(domain)) => {
            let current = match domain.get("nameservers") {
                Some(value) if crate::js::truthy(Some(value)) => value.clone(),
                _ => json!([]),
            };
            json_response(
                StatusCode::OK,
                json!({
                    "success": true,
                    "verified": false,
                    "requiredNameservers": REQUIRED_NAMESERVERS,
                    "currentNameservers": current,
                    "message": "Nameserver verification initiated. DNS propagation can take up to 48 hours.",
                }),
            )
        }
        Ok(None) => ApiError::not_found("Domain", Some(&id)).into_response(),
        Err(error) => internal(&error, "Failed to verify nameservers"),
    }
}

async fn verify_ownership(
    State(state): State<HostState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let providers = caller.providers(&state);
    let result: Result<Response, sqlx::Error> = async {
        let Some(domain) = live_domain(&caller.db, &id).await? else {
            return Ok(ApiError::not_found("Domain", Some(&id)).into_response());
        };
        if let Some(zone) = live_zone_of_domain(&caller.db, &id).await?
            && text(&zone, "provider") == Some("cloudflare")
        {
            let nameservers = [zone.get("externalNameservers"), domain.get("nameservers")]
                .into_iter()
                .flatten()
                .find(|v| !v.is_null())
                .cloned()
                .unwrap_or_else(|| json!([]));
            let mut body = public_domain(domain);
            body["nameservers"] = nameservers;
            body["dnsZone"] = zone;
            return Ok(Data(body).into_response());
        }
        let Some(token) = text(&domain, "nameserverVerificationToken").filter(|t| !t.is_empty()) else {
            return Ok(ApiError::bad_request(
                "This domain has no verification token. Re-add the domain.",
            )
            .into_response());
        };
        let full = text(&domain, "fullDomain").unwrap_or_default().to_owned();
        let expected = format!("weldhost-verify={token}");
        let record_name = format!("_weldhost-verify.{full}");
        let records = match crate::doh::lookup_txt(&providers.http, &record_name).await {
            Ok(records) => records,
            Err(error) => {
                tracing::error!(%error, "[domains.service] DNS lookup failed");
                return Ok(error_response(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "SERVICE_UNAVAILABLE",
                    "DNS lookup failed. Try again in a minute.",
                ));
            }
        };
        if !records.iter().any(|r| *r == expected) {
            return Ok(json_response(
                StatusCode::BAD_REQUEST,
                json!({
                    "success": false,
                    "error": {
                        "code": "VERIFICATION_FAILED",
                        "message": format!(
                            "TXT record not found at {record_name}. DNS propagation can take a few minutes after you add the record."
                        ),
                        "details": {
                            "expected": { "name": record_name, "type": "TXT", "value": expected },
                            "found": records,
                        },
                    },
                }),
            ));
        }
        let (Some(api_token), Some(account)) = (providers.cf_token.clone(), providers.cf_account.clone()) else {
            return Ok(ApiError::internal()
                .with_message("Cloudflare integration is not configured.")
                .into_response());
        };
        let dns = providers.dns(&api_token);
        let zone = match dns.create_zone(&account, &full).await {
            Ok(zone) => zone,
            Err(error) => {
                return Ok(match error.kind {
                    ZoneErrorKind::InAnotherAccount => json_response(
                        StatusCode::CONFLICT,
                        json!({
                            "success": false,
                            "error": {
                                "code": "DOMAIN_IN_ANOTHER_CF_ACCOUNT",
                                "message": "This domain is already registered on another Cloudflare account. Remove it there before adding it to WeldHost.",
                            },
                        }),
                    ),
                    ZoneErrorKind::AuthFailed => ApiError::internal()
                        .with_message("Cloudflare authentication failed.")
                        .into_response(),
                    ZoneErrorKind::InvalidDomain => ApiError::bad_request(error.message).into_response(),
                    ZoneErrorKind::Unknown => {
                        tracing::error!(%error, "[domains.service] Cloudflare zone creation failed");
                        ApiError::internal()
                            .with_message("Failed to create Cloudflare zone.")
                            .into_response()
                    }
                });
            }
        };
        let zone_row_id = generate_id("zone");
        let persisted: Result<(), sqlx::Error> = async {
            sqlx::query(
                "update domains set nameservers = $2, nameserver_verified = true,
                   nameserver_verification_pending = false, custom_nameservers = false,
                   updated_at = $3::timestamp where id = $1",
            )
            .bind(&id)
            .bind(json!(zone.nameservers))
            .bind(now())
            .execute(&caller.db)
            .await?;
            sqlx::query(
                "insert into dns_zones (id, domain_id, name, status, provider, external_zone_id,
                   external_nameservers)
                 values ($1, $2, $3, 'pending', 'cloudflare', $4, $5)",
            )
            .bind(&zone_row_id)
            .bind(&id)
            .bind(&full)
            .bind(&zone.zone_id)
            .bind(json!(zone.nameservers))
            .execute(&caller.db)
            .await?;
            Ok(())
        }
        .await;
        if let Err(error) = persisted {
            tracing::error!(%error, "[domains.service] DB write failed after zone creation, rolling back CF zone");
            dns.delete_zone(&zone.zone_id).await;
            return Ok(ApiError::internal()
                .with_message("Failed to persist zone. The Cloudflare zone was rolled back.")
                .into_response());
        }
        let updated = any_domain(&caller.db, &id).await?.unwrap_or(Value::Null);
        let new_zone = any_zone(&caller.db, &zone_row_id).await?.unwrap_or(Value::Null);
        caller.publish(
            &state,
            DNS_ZONE_CREATED,
            &zone_row_id,
            &json!({ "id": new_zone["id"], "name": new_zone["name"], "status": new_zone["status"] }),
        );
        let mut body = public_domain(updated);
        body["nameservers"] = json!(zone.nameservers);
        body["dnsZone"] = new_zone;
        Ok(Data(body).into_response())
    }
    .await;
    result.unwrap_or_else(|error| internal(&error, "Failed to verify ownership"))
}

async fn refresh_zone_status(
    State(state): State<HostState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let providers = caller.providers(&state);
    let result: Result<Response, sqlx::Error> = async {
        let Some((domain, zone)) = domain_with_zone(&caller.db, &id).await? else {
            return Ok(ApiError::not_found("Domain", Some(&id)).into_response());
        };
        let zone = zone.filter(|z| text(z, "provider") == Some("cloudflare"));
        let external = zone
            .as_ref()
            .and_then(|z| text(z, "externalZoneId"))
            .filter(|e| !e.is_empty())
            .map(str::to_owned);
        let (Some(zone), Some(external)) = (zone, external) else {
            return Ok(ApiError::bad_request("This domain does not have a Cloudflare zone yet.").into_response());
        };
        let Some(token) = providers.cf_token.clone() else {
            return Ok(ApiError::internal()
                .with_message("Cloudflare integration is not configured.")
                .into_response());
        };
        let zone_id = text(&zone, "id").unwrap_or_default().to_owned();
        let domain_status = text(&domain, "status").unwrap_or_default().to_owned();
        let cf_zone = match providers.dns(&token).get_zone(&external).await {
            Ok(cf_zone) => cf_zone,
            Err(error) => {
                tracing::error!(%error, "[domains.service] getCloudflareZone failed");
                return Ok(error_response(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "SERVICE_UNAVAILABLE",
                    "Could not reach Cloudflare. Try again in a moment.",
                ));
            }
        };
        let Some(cf_zone) = cf_zone else {
            let at = now();
            sqlx::query(
                "update dns_zones set status = 'error', sync_error = 'Zone no longer exists on Cloudflare',
                   synced_at = $2::timestamp, updated_at = $2::timestamp where id = $1",
            )
            .bind(&zone_id)
            .bind(&at)
            .execute(&caller.db)
            .await?;
            return Ok(Data(json!({
                "zoneStatus": "error",
                "domainStatus": domain_status,
                "cloudflareStatus": null,
            }))
            .into_response());
        };
        let next = match cf_zone.status.as_str() {
            "active" => "active",
            "pending" | "initializing" => "pending",
            _ => "error",
        };
        if Some(next) != text(&zone, "status") {
            let at = now();
            sqlx::query(
                "update dns_zones set status = $2::host_dns_zone_status, external_nameservers = $3,
                   synced_at = $4::timestamp, sync_error = $5, updated_at = $4::timestamp
                 where id = $1",
            )
            .bind(&zone_id)
            .bind(next)
            .bind(json!(cf_zone.nameservers))
            .bind(&at)
            .bind((next == "error").then(|| format!("Cloudflare status: {}", cf_zone.status)))
            .execute(&caller.db)
            .await?;
        }
        let mut status = domain_status;
        if is_external_registrar(text(&domain, "registrar")) && next == "active" && status == "pending" {
            status = "active".to_owned();
            sqlx::query(
                "update domains set status = 'active', nameservers = $2, updated_at = $3::timestamp where id = $1",
            )
            .bind(&id)
            .bind(json!(cf_zone.nameservers))
            .bind(now())
            .execute(&caller.db)
            .await?;
        }
        Ok(Data(json!({
            "zoneStatus": next,
            "domainStatus": status,
            "cloudflareStatus": cf_zone.status,
            "nameservers": cf_zone.nameservers,
        }))
        .into_response())
    }
    .await;
    result.unwrap_or_else(|error| internal(&error, "Failed to refresh zone status"))
}

async fn auth_code(State(state): State<HostState>, caller: Caller, Path(id): Path<String>) -> Response {
    let providers = caller.providers(&state);
    let result: Result<Response, sqlx::Error> = async {
        if is_domain_used(&caller.db, &id).await? {
            return Ok(domain_in_use());
        }
        let Some(domain) = live_domain(&caller.db, &id).await? else {
            return Ok(ApiError::not_found("Domain", Some(&id)).into_response());
        };
        let unavailable = |message: &str| Ok(ApiError::bad_request(message.to_owned()).into_response());
        match text(&domain, "registrar") {
            Some("cloudflare") => {
                return unavailable(
                    "Auth codes are not available via API for domains registered through Cloudflare Registrar.",
                );
            }
            Some("realtimeregister") => {}
            _ => {
                return unavailable(
                    "Auth codes are only available for domains registered through WeldHost (Realtime Register).",
                );
            }
        }
        let Some(rtr) = &providers.rtr else {
            return unavailable("Realtime Register is not configured");
        };
        let code = match rtr
            .get_auth_code(text(&domain, "fullDomain").unwrap_or_default())
            .await
        {
            Ok(code) => code,
            Err(error) => {
                tracing::error!(%error, "[domains.service] RTR authcode fetch failed");
                return unavailable(&error.message);
            }
        };
        let Some(code) = code.filter(|c| !c.is_empty()) else {
            return unavailable(
                "The registrar did not return an auth code for this domain yet. Try again shortly.",
            );
        };
        let expires = iso_timestamp(OffsetDateTime::now_utc() + Duration::days(7));
        sqlx::query(
            "update domains set auth_code = $2, auth_code_expires_at = $3::timestamp,
               updated_at = $4::timestamp where id = $1",
        )
        .bind(&id)
        .bind(&code)
        .bind(&expires)
        .bind(now())
        .execute(&caller.db)
        .await?;
        Ok(json_response(
            StatusCode::OK,
            json!({ "success": true, "authCode": code, "expiresAt": expires }),
        ))
    }
    .await;
    result.unwrap_or_else(|error| internal(&error, "Failed to get auth code"))
}

// ── Registrations ───────────────────────────────────────────────────────────

/// `registrationStatusFromDomain`.
fn registration_status_of(row: &Value) -> Value {
    let status = match text(row, "registrationStatus") {
        Some("pending_payment") => "pending",
        Some("pending_registration" | "pending_workflow") => "registering",
        Some("registered") => "completed",
        Some("failed" | "registration_failed") => "failed",
        _ => match text(row, "status") {
            Some("active") => "completed",
            Some("cancelled") => "failed",
            _ => "pending",
        },
    };
    let metadata_error = row
        .get("metadata")
        .and_then(Value::as_object)
        .filter(|m| m.contains_key("error"))
        .map(|m| {
            let error = &m["error"];
            if error.is_null() { String::new() } else { as_text(error) }
        })
        .unwrap_or_default();
    json!({
        "registrationId": row["id"],
        "domainId": if text(row, "status") == Some("active") { row["id"].clone() } else { Value::Null },
        "domainName": row["fullDomain"],
        "status": status,
        "totalPrice": null,
        "failureReason": if status == "failed" && !metadata_error.is_empty() { json!(metadata_error) } else { Value::Null },
    })
}

/// `pollRegistrationProcess`: drive a pending registration's process.
pub(crate) async fn poll_registration(
    db: &PgPool,
    rtr: &RealtimeRegistrar,
    id: &str,
) -> Result<Option<Value>, sqlx::Error> {
    let Some(domain) = live_domain(db, id).await? else {
        return Ok(None);
    };
    if matches!(
        text(&domain, "registrationStatus"),
        Some("pending_renewal" | "renewed")
    ) {
        return Ok(Some(domain));
    }
    let Some(process_id) = text(&domain, "rtrProcessId")
        .filter(|p| !p.is_empty())
        .and_then(parse_int)
        .filter(|p| *p > 0)
    else {
        return Ok(Some(domain));
    };
    let outcome = match rtr.poll_process(process_id).await {
        Ok(outcome) => outcome,
        Err(error) => {
            tracing::error!(%error, "[domains.service] pollRegistrationProcess pollProcess failed");
            return Ok(Some(domain));
        }
    };
    match outcome {
        Outcome::Pending => Ok(Some(domain)),
        Outcome::Failed => {
            let row: Option<Value> = sqlx::query_scalar(
                "update domains t set registration_status = 'registration_failed', status = 'cancelled',
                   updated_at = $2::timestamp where t.id = $1 returning to_jsonb(t)",
            )
            .bind(id)
            .bind(now())
            .fetch_optional(db)
            .await?;
            Ok(row.map(weldsuite_db::js_row))
        }
        Outcome::Completed => {
            let remote = match rtr
                .get_domain(text(&domain, "fullDomain").unwrap_or_default())
                .await
            {
                Ok(remote) => remote,
                Err(error) => {
                    tracing::error!(%error, "[domains.service] pollRegistrationProcess getDomain failed");
                    return Ok(Some(domain));
                }
            };
            let Ok(expires) = remote
                .expires_at
                .as_deref()
                .filter(|e| !e.is_empty())
                .map(|e| js_date_iso(e).ok_or(()))
                .transpose()
            else {
                return Ok(Some(domain));
            };
            let at = now();
            let row: Option<Value> = sqlx::query_scalar(
                "update domains t set status = 'active', registration_status = 'registered',
                   external_registrar_id = $2, registrar_status = $3, registered_at = $4::timestamp,
                   expires_at = $5::timestamp, locked = $6, privacy_protection = $7,
                   registrar_synced_at = $4::timestamp, updated_at = $4::timestamp
                 where t.id = $1 returning to_jsonb(t)",
            )
            .bind(id)
            .bind(&remote.id)
            .bind(remote.status.join(","))
            .bind(&at)
            .bind(expires)
            .bind(remote.locked)
            .bind(remote.privacy_protect)
            .fetch_optional(db)
            .await?;
            Ok(row.map(weldsuite_db::js_row))
        }
    }
}

/// `pollRenewalProcess`: drive a pending renewal's process.
pub(crate) async fn poll_renewal(
    db: &PgPool,
    rtr: &RealtimeRegistrar,
    id: &str,
) -> Result<Option<Value>, sqlx::Error> {
    let Some(domain) = live_domain(db, id).await? else {
        return Ok(None);
    };
    if text(&domain, "registrationStatus") != Some("pending_renewal") {
        return Ok(Some(domain));
    }
    let raw = domain.get("metadata").and_then(|m| m.get("rtrRenewalProcessId"));
    #[allow(clippy::cast_possible_truncation)]
    let process_id = match raw {
        Some(Value::String(text)) => parse_int(text),
        Some(Value::Number(n)) => n.as_f64().filter(|n| n.is_finite()).map(|n| n as i64),
        Some(Value::Bool(flag)) => Some(i64::from(*flag)),
        Some(Value::Null) => Some(0),
        _ => None,
    };
    let Some(process_id) = process_id.filter(|p| *p > 0) else {
        return Ok(Some(domain));
    };
    let outcome = match rtr.poll_process(process_id).await {
        Ok(outcome) => outcome,
        Err(error) => {
            tracing::error!(%error, "[domains.service] pollRenewalProcess pollProcess failed");
            return Ok(Some(domain));
        }
    };
    let metadata: Map<String, Value> = domain
        .get("metadata")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    match outcome {
        Outcome::Pending => Ok(Some(domain)),
        Outcome::Failed => {
            let mut metadata = metadata;
            metadata.insert("error".to_owned(), json!("Registrar renewal process failed"));
            let row: Option<Value> = sqlx::query_scalar(
                "update domains t set registration_status = 'failed', metadata = $2,
                   updated_at = $3::timestamp where t.id = $1 returning to_jsonb(t)",
            )
            .bind(id)
            .bind(Value::Object(metadata))
            .bind(now())
            .fetch_optional(db)
            .await?;
            Ok(row.map(weldsuite_db::js_row))
        }
        Outcome::Completed => {
            let remote = match rtr
                .get_domain(text(&domain, "fullDomain").unwrap_or_default())
                .await
            {
                Ok(remote) => remote,
                Err(error) => {
                    tracing::error!(%error, "[domains.service] pollRenewalProcess getDomain failed");
                    return Ok(Some(domain));
                }
            };
            let Ok(expires) = remote
                .expires_at
                .as_deref()
                .filter(|e| !e.is_empty())
                .map(|e| js_date_iso(e).ok_or(()))
                .transpose()
            else {
                return Ok(Some(domain));
            };
            let mut metadata = metadata;
            metadata.remove("rtrRenewalProcessId");
            let at = now();
            let row: Option<Value> = sqlx::query_scalar(
                "update domains t set status = 'active', registration_status = 'renewed',
                   renewed_at = $2::timestamp,
                   expires_at = case when $3 then $4::timestamp else expires_at end,
                   registrar_status = $5, registrar_synced_at = $2::timestamp, metadata = $6,
                   updated_at = $2::timestamp
                 where t.id = $1 returning to_jsonb(t)",
            )
            .bind(id)
            .bind(&at)
            .bind(expires.is_some())
            .bind(expires)
            .bind(remote.status.join(","))
            .bind(Value::Object(metadata))
            .fetch_optional(db)
            .await?;
            Ok(row.map(weldsuite_db::js_row))
        }
    }
}

async fn registration_status(
    State(state): State<HostState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let persisted = match any_domain(&caller.db, &id).await {
        Ok(Some(row)) => registration_status_of(&row),
        Ok(None) => return ApiError::not_found("Domain registration", Some(&id)).into_response(),
        Err(error) => return internal(&error, "Failed to fetch registration status"),
    };
    let providers = caller.providers(&state);
    if let Some(rtr) = &providers.rtr {
        match poll_registration(&caller.db, rtr, &id).await {
            Ok(Some(polled)) => return Data(registration_status_of(&polled)).into_response(),
            Ok(None) => {}
            Err(error) => tracing::error!(%error, "[app-api/domains] registration poll failed"),
        }
    }
    Data(persisted).into_response()
}

async fn complete_registration(
    State(state): State<HostState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let contact = match validate(&headers, &body, |issues, body| {
        issues
            .nested(body, "contactInfo", Presence::Optional, |_, fields| {
                Value::Object(fields.clone())
            })
            .into_option()
    }) {
        Ok(contact) => contact,
        Err(response) => return *response,
    };
    let result: Result<Response, sqlx::Error> = async {
        if any_domain(&caller.db, &id).await?.is_none() {
            return Ok(ApiError::not_found("Domain registration", Some(&id)).into_response());
        }
        let at = now();
        sqlx::query(
            "update domains set status = 'active', registration_status = 'registered',
               registered_at = $2::timestamp, registrant_contact = coalesce($3, registrant_contact),
               updated_at = $2::timestamp
             where id = $1",
        )
        .bind(&id)
        .bind(&at)
        .bind(contact)
        .execute(&caller.db)
        .await?;
        let Some(row) = any_domain(&caller.db, &id).await? else {
            return Ok(ApiError::not_found("Domain registration", Some(&id)).into_response());
        };
        caller.publish(&state, DOMAIN_UPDATED, &id, &domain_event(&id, &row));
        Ok(Data(json!({ "success": true, "domainId": id, "domain": public_domain(row) })).into_response())
    }
    .await;
    result.unwrap_or_else(|error| internal(&error, "Failed to complete registration"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markup_and_prices() {
        let pricing = Pricing {
            currency: Some("USD".to_owned()),
            registration_price: Some("12.99".to_owned()),
            markup_amount: None,
            markup_percent: Some("10.00".to_owned()),
        };
        assert_eq!(apply_markup(None, Some(&pricing), None), Some(1429.0));
        assert_eq!(apply_markup(Some(2000.0), Some(&pricing), Some("eur")), Some(1429.0));
        assert_eq!(apply_markup(Some(2000.0), Some(&pricing), Some("usd")), Some(2200.0));
        assert_eq!(apply_markup(None, None, None), None);
        assert!(is_fqdn("example.com"));
        assert!(!is_fqdn("-example.com"));
        assert!(!is_fqdn("example"));
        assert!(!is_fqdn("Example.com"));
    }

    #[test]
    fn registration_status_maps() {
        let row = json!({ "id": "dom_1", "fullDomain": "a.com", "status": "cancelled", "registrationStatus": null, "metadata": { "error": "boom" } });
        let status = registration_status_of(&row);
        assert_eq!(status["status"], "failed");
        assert_eq!(status["failureReason"], "boom");
        assert_eq!(status["domainId"], Value::Null);
    }
}
