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
use sea_orm::prelude::BigDecimal;
use sea_orm::sea_query::{Asterisk, Expr, Func};
use sea_orm::{
    ActiveEnum, ActiveValue::Set, ColumnTrait, Condition, DbErr, EntityTrait, FromQueryResult,
    PaginatorTrait, QueryFilter, QueryOrder, QuerySelect,
};
use serde_json::{Map, Value, json};
use time::{Duration, OffsetDateTime, PrimitiveDateTime};
use weldsuite_catalogs::entity_events::{
    DNS_ZONE_CREATED, DOMAIN_CREATED, DOMAIN_DELETED, DOMAIN_UPDATED, DOMAIN_USE_EXTERNAL,
};
use weldsuite_db::{PgPool, orm, utc_now, utc_timestamp};
use weldsuite_events::iso_timestamp;
use weldsuite_kit::validation::{Field, Format, Issues, Number, Presence, Text, js_date_iso};
use weldsuite_kit::{ApiError, Created, Data, NoContent, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::master::domain_pricing;
use weldsuite_schema::tenant::enums::{
    HostDnsProvider, HostDnsZoneStatus, HostDomainRegistrationStatus, HostDomainStatus,
};
use weldsuite_schema::tenant::{dns_zones, domains};

use crate::cloudflare::RegistrarError;
use crate::dns_host::ZoneErrorKind;
use crate::js::{
    as_text, number_json, parse_float, parse_int, random_uuid_hex, round, text, tld_of,
};
use crate::registrar::{
    CheckResult, OTE_SEARCH_DEFAULT_TLDS, Outcome, RealtimeRegistrar, RtrError, js_slice_end,
    tld_supports_privacy_protect,
};
use crate::rows::{
    any_domain, any_zone, domain_with_zone, is_external_registrar, is_hidden_unpaid, js, js_option,
    live_domain, live_zone_of_domain, public_domain, timestamp_of,
};
use crate::weldreach::{changes_nameservers, connected_domain_ids, domain_in_use, is_domain_used};
use crate::{
    Caller, DnsProvider, HostState, Providers, ZoneDns, dns_allowed, error_response, internal,
    json_response, now, validate, validate_query,
};

const STATUSES: [&str; 5] = ["active", "pending", "expired", "suspended", "cancelled"];

pub(crate) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<HostState>
where
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route(
            "/dashboard",
            get(dashboard).route_layer(need("domains:read")),
        )
        .route(
            "/dashboard/chart",
            get(chart).route_layer(need("domains:read")),
        )
        .route(
            "/dashboard/recent",
            get(recent).route_layer(need("domains:read")),
        )
        .route("/search", get(search).route_layer(need("domains:read")))
        .route("/check", post(check).route_layer(need("domains:read")))
        .route(
            "/checkout",
            post(checkout).route_layer(need("domains:create")),
        )
        .route(
            "/checkout/abandon",
            post(abandon).route_layer(need("domains:create")),
        )
        .route(
            "/external",
            post(external).route_layer(need("domains:create")),
        )
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
        .route(
            "/{id}/renew",
            post(renew).route_layer(need("domains:update")),
        )
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

/// `isListedDomainSql()`: unpaid checkout rows stay out of lists and counts
/// (`registration_status is distinct from 'pending_payment' and not (status =
/// 'cancelled' and registration_status is not distinct from 'failed')`).
fn listed() -> Condition {
    let registration = domains::Column::RegistrationStatus;
    Condition::all()
        .add(
            Condition::any()
                .add(registration.is_null())
                .add(registration.ne(HostDomainRegistrationStatus::PendingPayment)),
        )
        .add(
            Condition::any()
                .add(domains::Column::Status.ne(HostDomainStatus::Cancelled))
                .add(registration.is_null())
                .add(registration.ne(HostDomainRegistrationStatus::Failed)),
        )
}

/// The live, listed domains.
fn listed_domains() -> sea_orm::Select<domains::Entity> {
    domains::Entity::find()
        .filter(domains::Column::DeletedAt.is_null())
        .filter(listed())
}

/// `count(*) filter (where …)`: the rows the case keeps (it is null otherwise).
fn count_where(condition: Condition) -> Expr {
    Expr::from(Func::count(Expr::case(condition, 1)))
}

/// `count(*)`.
fn count_all() -> Expr {
    Expr::from(Func::count(Expr::col(Asterisk)))
}

/// `status = …` as a filtered count's condition.
fn status_is(status: HostDomainStatus) -> Condition {
    Condition::all().add(domains::Column::Status.eq(status))
}

/// A validated `status` as the column's enum.
fn domain_status(status: &str) -> Result<HostDomainStatus, DbErr> {
    HostDomainStatus::try_from_value(&status.to_owned())
}

/// The `dns_zones.provider` of a DNS host.
fn zone_provider(provider: DnsProvider) -> HostDnsProvider {
    match provider {
        DnsProvider::Cloudflare => HostDnsProvider::Cloudflare,
        DnsProvider::Hetzner => HostDnsProvider::Hetzner,
    }
}

// ── Errors ──────────────────────────────────────────────────────────────────

/// What a registrar-backed route can fail with.
enum Failure {
    Rtr(RtrError),
    Cf(RegistrarError),
    Db(DbErr),
    Other(String),
    /// Cloudflare is outside the EU and the workspace hasn't switched it on
    /// (ADR OPS-026).
    OutsideEu(weldsuite_outside_eu::OutsideEuError),
}

impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Rtr(error) => error.fmt(f),
            Self::Cf(error) => error.fmt(f),
            Self::Db(error) => error.fmt(f),
            Self::Other(message) => f.write_str(message),
            Self::OutsideEu(error) => error.fmt(f),
        }
    }
}

/// The legacy Cloudflare Registrar is Cloudflare too: a workspace's
/// domains go to it only once Cloudflare is switched on (ADR OPS-026).
async fn cloudflare_registrar_allowed(db: &PgPool) -> Result<(), Failure> {
    weldsuite_outside_eu::require(db, weldsuite_outside_eu::ServiceId::Cloudflare)
        .await
        .map_err(Failure::OutsideEu)
}

impl From<DbErr> for Failure {
    fn from(error: DbErr) -> Self {
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
    if let Failure::OutsideEu(error) = failure {
        return error.to_api_error().into_response();
    }
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
fn app_error(error: &DbErr) -> Response {
    tracing::error!(%error, "[host-api] domains");
    ApiError::internal().into_response()
}

fn domain_event(id: &str, row: &Value) -> Value {
    json!({ "id": id, "name": row["fullDomain"], "status": row["status"] })
}

// ── Dashboard ───────────────────────────────────────────────────────────────

/// The dashboard's counts.
#[derive(Debug, Default, FromQueryResult)]
struct DashboardStats {
    total: i64,
    active: i64,
    pending: i64,
    expired: i64,
    expiring: i64,
    ssl: i64,
    auto_renew: i64,
}

async fn dashboard(caller: Caller) -> Response {
    // `expires_at <= now() + interval '30 days'`, on the database's clock.
    let expiring = {
        use sea_orm::ExprTrait as _;
        Condition::all()
            .add(domains::Column::ExpiresAt.is_not_null())
            .add(
                Expr::col((domains::Entity, domains::Column::ExpiresAt))
                    .lte(Expr::current_timestamp().add(Expr::val("30 days").cast_as("interval"))),
            )
    };
    let stats = listed_domains()
        .select_only()
        .column_as(count_all(), "total")
        .column_as(count_where(status_is(HostDomainStatus::Active)), "active")
        .column_as(count_where(status_is(HostDomainStatus::Pending)), "pending")
        .column_as(count_where(status_is(HostDomainStatus::Expired)), "expired")
        .column_as(count_where(expiring), "expiring")
        .column_as(
            count_where(Condition::all().add(domains::Column::SslEnabled.eq(true))),
            "ssl",
        )
        .column_as(
            count_where(Condition::all().add(domains::Column::AutoRenew.eq(true))),
            "auto_renew",
        )
        .into_model::<DashboardStats>()
        .one(&orm(&caller.db))
        .await;
    match stats {
        Ok(stats) => {
            let stats = stats.unwrap_or_default();
            Data(json!({
                "totalDomains": stats.total,
                "activeDomains": stats.active,
                "pendingDomains": stats.pending,
                "expiredDomains": stats.expired,
                "expiringSoon": stats.expiring,
                "sslEnabled": stats.ssl,
                "autoRenewEnabled": stats.auto_renew,
            }))
            .into_response()
        }
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

/// A `timestamp` as the route's `Date` serializes: `toISOString()`.
fn js_date(at: PrimitiveDateTime) -> Option<String> {
    weldsuite_schema::js::timestamp::serialize(&at, serde_json::value::Serializer)
        .ok()
        .and_then(|value| value.as_str().map(str::to_owned))
}

#[allow(clippy::type_complexity)]
async fn chart(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let days = clamp_param(raw.as_deref(), "days", 90, 365);
    let rows: Result<
        Vec<(
            Option<PrimitiveDateTime>,
            Option<PrimitiveDateTime>,
            Option<PrimitiveDateTime>,
            HostDomainStatus,
        )>,
        DbErr,
    > = listed_domains()
        .select_only()
        .columns([
            domains::Column::RegisteredAt,
            domains::Column::RenewedAt,
            domains::Column::ExpiresAt,
            domains::Column::Status,
        ])
        .into_tuple()
        .all(&orm(&caller.db))
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
    let mut bump = |stamp: &Option<PrimitiveDateTime>, field: usize| {
        if let Some(day) = stamp.and_then(js_date).and_then(|s| day_of(&s))
            && let Some(point) = points.iter_mut().find(|(d, _)| *d == day)
        {
            point.1[field] += 1;
        }
    };
    for (registered, renewed, expires, status) in &rows {
        bump(registered, 0);
        bump(renewed, 1);
        if *status == HostDomainStatus::Expired {
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
    let rows: Result<Vec<Value>, DbErr> = async {
        listed_domains()
            .order_by_desc(domains::Column::CreatedAt)
            .limit(u64::try_from(limit).unwrap_or(0))
            .all(&orm(&caller.db))
            .await?
            .into_iter()
            .map(|row| js!(row).map(public_domain))
            .collect()
    }
    .await;
    match rows {
        Ok(rows) => Data(rows).into_response(),
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
#[allow(clippy::type_complexity)]
async fn pricing_map(master: &PgPool) -> Result<Vec<(String, Pricing)>, DbErr> {
    let rows: Vec<(String, String, BigDecimal, Option<i32>, Option<BigDecimal>)> =
        domain_pricing::Entity::find()
            .select_only()
            .columns([
                domain_pricing::Column::Tld,
                domain_pricing::Column::Currency,
                domain_pricing::Column::RegistrationPrice,
                domain_pricing::Column::MarkupAmount,
                domain_pricing::Column::MarkupPercent,
            ])
            .filter(domain_pricing::Column::IsActive.eq(true))
            .into_tuple()
            .all(&orm(master))
            .await?;
    let mut map: Vec<(String, Pricing)> = Vec::new();
    for (tld, currency, registration_price, markup_amount, markup_percent) in rows {
        let key = tld.strip_prefix('.').unwrap_or(&tld).to_lowercase();
        let pricing = Pricing {
            currency: Some(currency),
            registration_price: Some(numeric_text(&registration_price)),
            markup_amount,
            markup_percent: markup_percent.as_ref().map(numeric_text),
        };
        if let Some(slot) = map.iter_mut().find(|(k, _)| *k == key) {
            slot.1 = pricing;
        } else {
            map.push((key, pricing));
        }
    }
    Ok(map)
}

/// `numeric(p, 2)::text`: exactly two decimals.
fn numeric_text(value: &BigDecimal) -> String {
    value.with_scale(2).to_plain_string()
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
fn apply_markup(
    wholesale: Option<f64>,
    pricing: Option<&Pricing>,
    currency: Option<&str>,
) -> Option<f64> {
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
        price
            .filter(|p| p.is_finite())
            .map_or(Value::Null, number_json),
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
fn searchable(providers: &Providers) -> Result<RealtimeRegistrar, Box<Response>> {
    let Some(rtr) = providers.rtr.clone() else {
        return Err(Box::new(rtr_unconfigured()));
    };
    if !rtr.can_search() {
        return Err(Box::new(error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "SERVICE_UNAVAILABLE",
            "Realtime Register ADAC is not configured",
        )));
    }
    Ok(rtr)
}

fn no_master() -> Failure {
    Failure::Other("no master database".to_owned())
}

async fn search(
    State(state): State<HostState>,
    caller: Caller,
    RawQuery(raw): RawQuery,
) -> Response {
    let (q, limit) = match validate_query(raw.as_deref(), |issues, query| {
        let q = issues
            .text(query, "q", Presence::Required, Some(2), None)
            .into_option();
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
        Err(response) => return *response,
    };
    let result: Result<Vec<Value>, Failure> = async {
        let master = caller.master(&state).ok_or_else(no_master)?;
        let limit = limit.min(50.0);
        if rtr.is_ote() {
            let map = pricing_map(&master).await?;
            let results = rtr
                .search_domains(&q, &ote_search_tlds(&map), limit)
                .await?;
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
            .list(
                body,
                "domains",
                Presence::Required,
                Some(1),
                Some(20),
                |issues, item| issues.item_text(item, Text::length(Some(1), None)),
            )
            .into_option()
            .unwrap_or_default()
    }) {
        Ok(domains) => domains,
        Err(response) => return *response,
    };
    let rtr = match searchable(&caller.providers(&state)) {
        Ok(rtr) => rtr,
        Err(response) => return *response,
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
    let domains = issues.list(
        body,
        "domains",
        Presence::Optional,
        Some(1),
        Some(10),
        |issues, item| issues.item_text(item, Text::length(Some(3), None)),
    );
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
            .list(
                body,
                "registrationIds",
                Presence::Required,
                Some(1),
                Some(20),
                |issues, item| issues.item_text(item, Text::length(Some(1), None)),
            )
            .into_option()
            .unwrap_or_default()
    }) {
        Ok(ids) => ids,
        Err(response) => return *response,
    };
    let result: Result<Vec<(String, String, HostDomainStatus)>, DbErr> = async {
        let db = orm(&caller.db);
        let registration = domains::Column::RegistrationStatus;
        let rows: Vec<(String, String, HostDomainStatus)> = domains::Entity::find()
            .select_only()
            .columns([
                domains::Column::Id,
                domains::Column::FullDomain,
                domains::Column::Status,
            ])
            .filter(domains::Column::DeletedAt.is_null())
            .filter(
                Condition::any()
                    .add(registration.eq(HostDomainRegistrationStatus::PendingPayment))
                    .add(
                        Condition::all()
                            .add(domains::Column::Status.eq(HostDomainStatus::Cancelled))
                            .add(registration.eq(HostDomainRegistrationStatus::Failed)),
                    ),
            )
            .filter(domains::Column::Id.is_in(ids.clone()))
            .into_tuple()
            .all(&db)
            .await?;
        if rows.is_empty() {
            return Ok(rows);
        }
        let deleted: Vec<String> = rows.iter().map(|(id, _, _)| id.clone()).collect();
        let at = utc_now();
        domains::Entity::update_many()
            .set(domains::ActiveModel {
                deleted_at: Set(Some(at)),
                updated_at: Set(at),
                ..Default::default()
            })
            .filter(domains::Column::Id.is_in(deleted))
            .exec(&db)
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

/// Special-use TLDs (RFC 2606 / 6761 / 6762), `RESERVED_TLDS`: a TXT record
/// on them can never be verified.
const RESERVED_TLDS: [&str; 5] = ["example", "test", "invalid", "localhost", "local"];

/// `externalDomainProblem(domain) === 'reserved'`: a valid name whose TLD is
/// special-use.
fn is_reserved_domain(domain: &str) -> bool {
    (3..=253).contains(&domain.len())
        && is_fqdn(domain)
        && domain
            .rsplit('.')
            .next()
            .is_some_and(|tld| RESERVED_TLDS.contains(&tld))
}

#[allow(clippy::too_many_lines)]
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
            // The schema's refine, which runs after a failed regex too but
            // only objects to a valid name.
            if is_reserved_domain(&transformed) {
                issues.issue_at(
                    "domain",
                    json!({
                        "code": "custom",
                        "message": "This top-level domain is reserved and can never be verified",
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
    let result: Result<Response, DbErr> = async {
        let existing: Option<HostDomainStatus> = domains::Entity::find()
            .select_only()
            .column(domains::Column::Status)
            .filter(domains::Column::FullDomain.eq(&domain))
            .filter(domains::Column::DeletedAt.is_null())
            .into_tuple()
            .one(&orm(&caller.db))
            .await?;
        if existing.is_some_and(|status| status != HostDomainStatus::Cancelled) {
            return Ok(ApiError::conflict(
                "This domain is already being managed in your workspace.",
            )
            .into_response());
        }
        let parts: Vec<&str> = domain.split('.').collect();
        let name = parts
            .first()
            .copied()
            .filter(|p| !p.is_empty())
            .unwrap_or(&domain);
        let tld = parts.get(1..).map(|p| p.join(".")).unwrap_or_default();
        let tld = if tld.is_empty() {
            "com".to_owned()
        } else {
            tld
        };
        let id = generate_id("dom");
        let token = random_uuid_hex();
        // Renewal stays with the outside registrar: WeldSuite never renews it.
        let row = domains::ActiveModel {
            id: Set(id.clone()),
            name: Set(name.to_owned()),
            tld: Set(tld),
            full_domain: Set(domain.clone()),
            status: Set(HostDomainStatus::Pending),
            registrar: Set(Some(
                registrar
                    .filter(|r| !r.is_empty())
                    .unwrap_or_else(|| "External".to_owned()),
            )),
            custom_nameservers: Set(Some(false)),
            nameserver_verified: Set(Some(false)),
            nameserver_verification_pending: Set(Some(true)),
            nameserver_verification_token: Set(Some(token.clone())),
            auto_renew: Set(Some(false)),
            ..Default::default()
        };
        domains::Entity::insert(row)
            .exec_without_returning(&orm(&caller.db))
            .await?;
        let row = any_domain(&caller.db, &id).await?.unwrap_or(Value::Null);
        caller.publish(&state, DOMAIN_USE_EXTERNAL, &id, &domain_event(&id, &row));
        let mut body = public_domain(row);
        body["verificationRecord"] = verification_record(&domain, &token);
        Ok(Created(body).into_response())
    }
    .await;
    result.unwrap_or_else(|error| internal(&error, "Failed to add external domain"))
}

/// `externalDomainVerificationRecord`: the TXT record that proves ownership.
fn verification_record(full_domain: &str, token: &str) -> Value {
    json!({
        "name": format!("_weldhost-verify.{full_domain}"),
        "type": "TXT",
        "value": format!("weldhost-verify={token}"),
    })
}

/// `pendingVerificationRecord`: the TXT record an external domain still has to
/// publish, or null once it is verified (it has a Cloudflare zone) or is not an
/// external domain at all.
fn pending_verification_record(domain: &Value, zone: Option<&Value>) -> Value {
    if !is_external_registrar(text(domain, "registrar")) {
        return Value::Null;
    }
    let Some(token) = text(domain, "nameserverVerificationToken").filter(|t| !t.is_empty()) else {
        return Value::Null;
    };
    let verified = zone.is_some_and(|z| {
        text(z, "provider") == Some("cloudflare") && z.get("deletedAt").is_none_or(Value::is_null)
    });
    if verified {
        return Value::Null;
    }
    verification_record(text(domain, "fullDomain").unwrap_or_default(), token)
}

// ── List, read, create, update, delete ──────────────────────────────────────

/// `orderBy` of `GET /`: the column and its direction.
fn list_order(
    select: sea_orm::Select<domains::Entity>,
    sort_by: Option<&str>,
    ascending: bool,
) -> sea_orm::Select<domains::Entity> {
    let column = match sort_by {
        Some("fullDomain") => domains::Column::FullDomain,
        Some("status") => domains::Column::Status,
        Some("expiresAt") => domains::Column::ExpiresAt,
        _ => domains::Column::CreatedAt,
    };
    if ascending {
        select.order_by_asc(column)
    } else {
        select.order_by_desc(column)
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
    let search = issues
        .text(q, "search", Presence::Optional, None, None)
        .into_option();
    let status = issues
        .choice(
            q,
            "status",
            Presence::Optional,
            &[
                "all",
                "active",
                "pending",
                "expired",
                "suspended",
                "cancelled",
            ],
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

#[allow(clippy::cast_possible_truncation, clippy::cast_precision_loss)] // the page count
async fn list(caller: Caller, RawQuery(raw): RawQuery) -> Response {
    let query = match validate_query(raw.as_deref(), read_list_query) {
        Ok(query) => query,
        Err(response) => return *response,
    };
    let result: Result<Value, DbErr> = async {
        let db = orm(&caller.db);
        let page_size = query.page_size.min(100);
        let search = query
            .search
            .filter(|s| !s.is_empty())
            .map(|s| format!("%{s}%"));
        let status = query
            .status
            .filter(|s| !s.is_empty() && s != "all")
            .map(|status| domain_status(&status))
            .transpose()?;
        let filtered = || {
            let mut select = listed_domains();
            if let Some(search) = &search {
                select = select.filter(
                    Condition::any()
                        .add(domains::Column::FullDomain.like(search.as_str()))
                        .add(domains::Column::Name.like(search.as_str())),
                );
            }
            if let Some(status) = status {
                select = select.filter(domains::Column::Status.eq(status));
            }
            select
        };
        let total = filtered().count(&db).await?;
        let rows = list_order(filtered(), query.sort_by.as_deref(), query.ascending)
            .limit(u64::try_from(page_size).unwrap_or(0))
            .offset(u64::try_from((query.page - 1).saturating_mul(page_size)).unwrap_or(0))
            .all(&db)
            .await?;
        let counts = listed_domains()
            .select_only()
            .column_as(count_all(), "total")
            .column_as(count_where(status_is(HostDomainStatus::Active)), "active")
            .column_as(count_where(status_is(HostDomainStatus::Pending)), "pending")
            .column_as(count_where(status_is(HostDomainStatus::Expired)), "expired")
            .into_tuple::<(i64, i64, i64, i64)>()
            .one(&db)
            .await?;
        let (all, active, pending, expired) = counts.unwrap_or_default();
        let domains: Vec<Value> = rows
            .into_iter()
            .map(|row| js!(row).map(public_domain))
            .collect::<Result<_, _>>()?;
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
        let total_pages = ((total as f64 / page_size as f64).ceil() as i64).max(1);
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
    let result: Result<Response, DbErr> = async {
        let Some((domain, zone)) = domain_with_zone(&caller.db, &id).await? else {
            return Ok(ApiError::not_found("Domain", Some(&id)).into_response());
        };
        if is_hidden_unpaid(&domain) {
            return Ok(ApiError::not_found("Domain", Some(&id)).into_response());
        }
        // Lets a pending external domain pick up its TXT verification again.
        let verification = pending_verification_record(&domain, zone.as_ref());
        let mut body = public_domain(domain);
        body["dnsZone"] = zone.unwrap_or(Value::Null);
        body["usedByWeldReach"] = json!(is_domain_used(&caller.db, &id).await?);
        body["verificationRecord"] = verification;
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
            if let Field::Set(value) =
                issues.text(body, key, Presence::Required, Some(1), Some(max))
            {
                out.insert(key.to_owned(), json!(value));
            }
        }
        let status = issues
            .choice(body, "status", Presence::Optional, &STATUSES)
            .into_option()
            .unwrap_or_else(|| "pending".to_owned());
        out.insert("status".to_owned(), json!(status));
        if let Field::Set(registrar) =
            issues.text(body, "registrar", Presence::Optional, None, Some(255))
        {
            out.insert("registrar".to_owned(), json!(registrar));
        }
        if let Field::Set(nameservers) = issues.list(
            body,
            "nameservers",
            Presence::Optional,
            None,
            None,
            |issues, item| issues.item_text(item, Text::default()),
        ) {
            out.insert("nameservers".to_owned(), json!(nameservers));
        }
        for (key, default) in [
            ("customNameservers", false),
            ("autoRenew", true),
            ("privacyProtection", false),
            ("locked", true),
        ] {
            let flag = issues
                .boolean(body, key, Presence::Optional)
                .into_option()
                .unwrap_or(default);
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
    let result: Result<Response, DbErr> = async {
        let row = domains::ActiveModel {
            id: Set(id.clone()),
            name: Set(text_of("name").unwrap_or_default()),
            tld: Set(text_of("tld").unwrap_or_default()),
            full_domain: Set(text_of("fullDomain").unwrap_or_default()),
            status: Set(domain_status(&text_of("status").unwrap_or_default())?),
            registrar: Set(text_of("registrar")),
            nameservers: Set(input.get("nameservers").cloned()),
            custom_nameservers: Set(flag("customNameservers")),
            auto_renew: Set(flag("autoRenew")),
            privacy_protection: Set(flag("privacyProtection")),
            locked: Set(flag("locked")),
            notes: Set(text_of("notes")),
            ..Default::default()
        };
        domains::Entity::insert(row)
            .exec_without_returning(&orm(&caller.db))
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
            "text" => issues
                .text(body, key, Presence::Optional, min, max)
                .into_option()
                .map(Value::from),
            "nullish" => match issues.text(body, key, Presence::Nullish, None, max) {
                Field::Set(v) => Some(Value::from(v)),
                Field::Null => Some(Value::Null),
                Field::Absent => None,
            },
            "status" => issues
                .choice(body, key, Presence::Optional, &STATUSES)
                .into_option()
                .map(Value::from),
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
            "bool" => issues
                .boolean(body, key, Presence::Optional)
                .into_option()
                .map(Value::from),
            _ => issues
                .nested(body, key, Presence::Optional, |_, fields| {
                    Value::Object(fields.clone())
                })
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
async fn write_update(
    db: &PgPool,
    id: &str,
    data: &Map<String, Value>,
) -> Result<Option<Value>, Failure> {
    if live_domain(db, id).await?.is_none() {
        return Ok(None);
    }
    let row = update_columns(data)?;
    domains::Entity::update_many()
        .set(row)
        .filter(domains::Column::Id.eq(id))
        .exec(&orm(db))
        .await?;
    Ok(any_domain(db, id).await?)
}

/// The columns `updateDomain` writes: each field the body gave, and
/// `updatedAt`.
fn update_columns(data: &Map<String, Value>) -> Result<domains::ActiveModel, Failure> {
    let text = |key: &str| data.get(key).and_then(Value::as_str).map(str::to_owned);
    let stamp = |key: &str| -> Result<Option<PrimitiveDateTime>, Failure> {
        match data.get(key).and_then(Value::as_str) {
            None => Ok(None),
            Some(raw) => {
                let iso = js_date_iso(raw)
                    .ok_or_else(|| Failure::Other("RangeError: Invalid time value".to_owned()))?;
                Ok(Some(timestamp_of(&iso)?))
            }
        }
    };
    let flag = |key: &str| data.get(key).and_then(Value::as_bool);
    let json_of = |key: &str| data.get(key).cloned().filter(|v| !v.is_null());
    let mut row = domains::ActiveModel::default();
    for (key, _) in UPDATE_FIELDS {
        if !data.contains_key(key) {
            continue;
        }
        match key {
            "name" => row.name = Set(text(key).unwrap_or_default()),
            "tld" => row.tld = Set(text(key).unwrap_or_default()),
            "fullDomain" => row.full_domain = Set(text(key).unwrap_or_default()),
            "status" => row.status = Set(domain_status(&text(key).unwrap_or_default())?),
            "registrar" => row.registrar = Set(text(key)),
            "externalRegistrarId" => row.external_registrar_id = Set(text(key)),
            "registrarStatus" => row.registrar_status = Set(text(key)),
            "registrarSyncedAt" => row.registrar_synced_at = Set(stamp(key)?),
            "registeredAt" => row.registered_at = Set(stamp(key)?),
            "expiresAt" => row.expires_at = Set(stamp(key)?),
            "renewedAt" => row.renewed_at = Set(stamp(key)?),
            "nameservers" => row.nameservers = Set(json_of(key)),
            "customNameservers" => row.custom_nameservers = Set(flag(key)),
            "nameserverVerified" => row.nameserver_verified = Set(flag(key)),
            "nameserverVerificationPending" => {
                row.nameserver_verification_pending = Set(flag(key));
            }
            "autoRenew" => row.auto_renew = Set(flag(key)),
            "privacyProtection" => row.privacy_protection = Set(flag(key)),
            "locked" => row.locked = Set(flag(key)),
            "sslEnabled" => row.ssl_enabled = Set(flag(key)),
            "emailForwardingEnabled" => row.email_forwarding_enabled = Set(flag(key)),
            "authCode" => row.auth_code = Set(text(key)),
            "authCodeExpiresAt" => row.auth_code_expires_at = Set(stamp(key)?),
            "registrantContact" => row.registrant_contact = Set(json_of(key)),
            "adminContact" => row.admin_contact = Set(json_of(key)),
            "techContact" => row.tech_contact = Set(json_of(key)),
            "billingContact" => row.billing_contact = Set(json_of(key)),
            "notes" => row.notes = Set(text(key)),
            "metadata" => row.metadata = Set(json_of(key)),
            _ => {}
        }
    }
    row.updated_at = Set(utc_now());
    Ok(row)
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

async fn remove(
    State(state): State<HostState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let result: Result<Response, DbErr> = async {
        if is_domain_used(&caller.db, &id).await? {
            return Ok(domain_in_use());
        }
        let Some(existing) = live_domain(&caller.db, &id).await? else {
            return Ok(ApiError::not_found("Domain", Some(&id)).into_response());
        };
        let at = utc_now();
        domains::Entity::update_many()
            .set(domains::ActiveModel {
                deleted_at: Set(Some(at)),
                updated_at: Set(at),
                ..Default::default()
            })
            .filter(domains::Column::Id.eq(&id))
            .exec(&orm(&caller.db))
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
        issues
            .boolean(body, key, Presence::Required)
            .into_option()
            .unwrap_or_default()
    })
}

/// The registrar a domain row is on, when it has an id there.
fn registered_at(domain: &Value) -> Option<&str> {
    text(domain, "externalRegistrarId")
        .filter(|id| !id.is_empty())
        .and(text(domain, "registrar"))
}

/// `update domains set … where id = $1 returning *`: the row as it is
/// now, `None` for no row.
async fn update_returning(
    db: &PgPool,
    id: &str,
    row: domains::ActiveModel,
) -> Result<Option<Value>, DbErr> {
    let updated = domains::Entity::update_many()
        .set(row)
        .filter(domains::Column::Id.eq(id))
        .exec_with_returning(&orm(db))
        .await?;
    js_option!(updated.into_iter().next())
}

/// `update domains set <flag> = value, updated_at = now() … returning *`.
async fn set_flag(
    db: &PgPool,
    id: &str,
    set: impl FnOnce(&mut domains::ActiveModel),
) -> Result<Option<Value>, DbErr> {
    let mut row = domains::ActiveModel::default();
    set(&mut row);
    row.updated_at = Set(utc_now());
    update_returning(db, id, row).await
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
                let rtr = providers.rtr.as_ref().ok_or_else(|| {
                    Failure::Other("Realtime Register is not configured".to_owned())
                })?;
                rtr.update_domain(full, &json!({ "autoRenew": false }))
                    .await?;
            }
            Some("cloudflare") => {
                let cf = providers.cf_registrar().ok_or_else(|| {
                    Failure::Other("Cloudflare Registrar is not configured".to_owned())
                })?;
                cloudflare_registrar_allowed(&caller.db).await?;
                cf.update_domain(full, Some(enabled), None).await?;
            }
            _ => {}
        }
        Ok(set_flag(&caller.db, &id, |row| row.auto_renew = Set(Some(enabled))).await?)
    }
    .await;
    match result {
        Ok(updated) => toggled(&state, &caller, &id, updated),
        Err(failure) => {
            registrar_failure("toggle-auto-renew", &failure, "Failed to toggle auto-renew")
        }
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
        Ok(set_flag(&caller.db, &id, |row| {
            row.privacy_protection = Set(Some(enabled));
        })
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
                let rtr = providers.rtr.as_ref().ok_or_else(|| {
                    Failure::Other("Realtime Register is not configured".to_owned())
                })?;
                rtr.set_transfer_lock(full, locked).await?;
            }
            Some("cloudflare") => {
                let cf = providers.cf_registrar().ok_or_else(|| {
                    Failure::Other("Cloudflare Registrar is not configured".to_owned())
                })?;
                cloudflare_registrar_allowed(&caller.db).await?;
                cf.update_domain(full, None, Some(locked)).await?;
            }
            _ => {}
        }
        Ok(set_flag(&caller.db, &id, |row| row.locked = Set(Some(locked))).await?)
    }
    .await;
    match result {
        Ok(updated) => toggled(&state, &caller, &id, updated),
        Err(failure) => {
            registrar_failure("toggle-lock", &failure, "Failed to toggle transfer lock")
        }
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
fn date_or_fail(text: &str) -> Result<PrimitiveDateTime, Failure> {
    let iso = js_date_iso(text)
        .ok_or_else(|| Failure::Other("RangeError: Invalid time value".to_owned()))?;
    Ok(timestamp_of(&iso)?)
}

/// `syncDomainStatus`.
async fn sync_status(
    db: &PgPool,
    providers: &Providers,
    id: &str,
) -> Result<Option<Value>, Failure> {
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
        let at = utc_now();
        let mut row = domains::ActiveModel {
            external_registrar_id: Set(Some(remote.id.clone())),
            registrar_status: Set(Some(remote.status.join(","))),
            locked: Set(Some(remote.locked)),
            privacy_protection: Set(Some(remote.privacy_protect)),
            registrar_synced_at: Set(Some(at)),
            updated_at: Set(at),
            ..Default::default()
        };
        if let Some(expires) = expires {
            row.expires_at = Set(Some(expires));
        }
        // `coalesce($code, auth_code)`.
        if let Some(code) = &remote.auth_code {
            row.auth_code = Set(Some(code.clone()));
        }
        if ok {
            row.status = Set(HostDomainStatus::Active);
        }
        if can_mark {
            row.registration_status = Set(Some(HostDomainRegistrationStatus::Registered));
        }
        return Ok(update_returning(db, id, row).await?);
    }
    if registrar == Some("cloudflare")
        && let Some(cf) = providers.cf_registrar()
    {
        cloudflare_registrar_allowed(db).await?;
        let remote = cf.get_domain(&full).await?;
        let expires = remote
            .expires_at
            .as_deref()
            .filter(|e| !e.is_empty())
            .map(date_or_fail)
            .transpose()?;
        let at = utc_now();
        let mut row = domains::ActiveModel {
            external_registrar_id: Set(Some(remote.id.clone())),
            registrar_status: Set((!remote.status.is_null()).then(|| as_text(&remote.status))),
            locked: Set(remote.locked.as_bool()),
            auto_renew: Set(remote.auto_renew.as_bool()),
            registrar_synced_at: Set(Some(at)),
            updated_at: Set(at),
            ..Default::default()
        };
        if let Some(expires) = expires {
            row.expires_at = Set(Some(expires));
        }
        if remote.status.as_str() == Some("active") {
            row.status = Set(HostDomainStatus::Active);
        }
        if can_mark {
            row.registration_status = Set(Some(HostDomainRegistrationStatus::Registered));
        }
        return Ok(update_returning(db, id, row).await?);
    }
    Ok(Some(domain))
}

async fn sync(State(state): State<HostState>, caller: Caller, Path(id): Path<String>) -> Response {
    let providers = caller.providers(&state);
    if providers.rtr.is_none() && providers.cf_registrar().is_none() {
        let found = async {
            if live_domain(&caller.db, &id).await?.is_none() {
                return Ok::<_, DbErr>(false);
            }
            domains::Entity::update_many()
                .set(domains::ActiveModel {
                    registrar_synced_at: Set(Some(utc_now())),
                    updated_at: Set(utc_now()),
                    ..Default::default()
                })
                .filter(domains::Column::Id.eq(&id))
                .exec(&orm(&caller.db))
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
        Err(Failure::OutsideEu(error)) => error.to_api_error().into_response(),
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

/// The worker's list, answered where `WELDHOST_NAMESERVERS` is unset.
const REQUIRED_NAMESERVERS: [&str; 4] = [
    "ns1.weldhost.com",
    "ns2.weldhost.com",
    "ns3.weldhost.com",
    "ns4.weldhost.com",
];

async fn verify_nameservers(
    State(state): State<HostState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let configured = caller.providers(&state).nameservers;
    let required: Vec<String> = if configured.is_empty() {
        REQUIRED_NAMESERVERS.map(str::to_owned).to_vec()
    } else {
        configured
    };
    let result: Result<Option<Value>, DbErr> = async {
        let Some(domain) = live_domain(&caller.db, &id).await? else {
            return Ok(None);
        };
        domains::Entity::update_many()
            .set(domains::ActiveModel {
                nameserver_verification_pending: Set(Some(true)),
                updated_at: Set(utc_now()),
                ..Default::default()
            })
            .filter(domains::Column::Id.eq(&id))
            .exec(&orm(&caller.db))
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
                    "requiredNameservers": required,
                    "currentNameservers": current,
                    "message": "Nameserver verification initiated. DNS propagation can take up to 48 hours.",
                }),
            )
        }
        Ok(None) => ApiError::not_found("Domain", Some(&id)).into_response(),
        Err(error) => internal(&error, "Failed to verify nameservers"),
    }
}

#[allow(clippy::too_many_lines)] // the lookup, the zone and the rollback
async fn verify_ownership(
    State(state): State<HostState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let providers = caller.providers(&state);
    let result: Result<Response, DbErr> = async {
        let Some(domain) = live_domain(&caller.db, &id).await? else {
            return Ok(ApiError::not_found("Domain", Some(&id)).into_response());
        };
        // On a Hetzner install a `hetzner` row without an external id is a
        // zone kept by hand (the column's default provider): the zone made
        // below takes it over instead of answering it as made.
        let mut take_over: Option<String> = None;
        if let Some(zone) = live_zone_of_domain(&caller.db, &id).await? {
            let provider = text(&zone, "provider");
            let on_hetzner =
                providers.dns_provider == DnsProvider::Hetzner && provider == Some("hetzner");
            let hosted = text(&zone, "externalZoneId").is_some_and(|e| !e.is_empty());
            if provider == Some("cloudflare") || (on_hetzner && hosted) {
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
            if on_hetzner {
                take_over = text(&zone, "id").map(str::to_owned);
            }
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
        if !records.contains(&expected) {
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
        let Some((provider, dns, account)) = providers.new_zone_host() else {
            return Ok(ApiError::internal()
                .with_message(format!(
                    "{} integration is not configured.",
                    providers.dns_provider.label()
                ))
                .into_response());
        };
        if let Err(refusal) = dns_allowed(&caller.db, provider).await {
            return Ok(refusal);
        }
        let label = provider.label();
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
                                "message": match provider {
                                    DnsProvider::Cloudflare => "This domain is already registered on another Cloudflare account. Remove it there before adding it to WeldHost.",
                                    DnsProvider::Hetzner => "This domain already has a DNS zone at Hetzner, in another account or another workspace. Remove it there before adding it to WeldHost.",
                                },
                            },
                        }),
                    ),
                    ZoneErrorKind::AuthFailed => ApiError::internal()
                        .with_message(format!("{label} authentication failed."))
                        .into_response(),
                    ZoneErrorKind::InvalidDomain => ApiError::bad_request(error.message).into_response(),
                    ZoneErrorKind::Unknown => {
                        tracing::error!(%error, "[domains.service] {label} zone creation failed");
                        ApiError::internal()
                            .with_message(format!("Failed to create {label} zone."))
                            .into_response()
                    }
                });
            }
        };
        let zone_row_id = take_over.clone().unwrap_or_else(|| generate_id("zone"));
        let persisted = persist_zone(
            &caller.db,
            &id,
            &full,
            &zone,
            zone_provider(provider),
            &zone_row_id,
            take_over.is_some(),
        )
        .await;
        if let Err(error) = persisted {
            tracing::error!(%error, "[domains.service] DB write failed after zone creation, rolling back the {label} zone");
            dns.delete_zone(&zone.id).await;
            return Ok(ApiError::internal()
                .with_message(format!("Failed to persist zone. The {label} zone was rolled back."))
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

/// The verified domain's nameservers and its zone row: a new one, or the
/// zone kept by hand that it takes over.
async fn persist_zone(
    db: &PgPool,
    id: &str,
    full: &str,
    zone: &crate::dns_host::Zone,
    provider: HostDnsProvider,
    zone_row_id: &str,
    take_over: bool,
) -> Result<(), DbErr> {
    let db = orm(db);
    domains::Entity::update_many()
        .set(domains::ActiveModel {
            nameservers: Set(Some(json!(zone.nameservers))),
            nameserver_verified: Set(Some(true)),
            nameserver_verification_pending: Set(Some(false)),
            custom_nameservers: Set(Some(false)),
            updated_at: Set(utc_now()),
            ..Default::default()
        })
        .filter(domains::Column::Id.eq(id))
        .exec(&db)
        .await?;
    if take_over {
        dns_zones::Entity::update_many()
            .set(dns_zones::ActiveModel {
                name: Set(full.to_owned()),
                status: Set(HostDnsZoneStatus::Pending),
                provider: Set(provider),
                external_zone_id: Set(Some(zone.id.clone())),
                external_nameservers: Set(Some(json!(zone.nameservers))),
                updated_at: Set(utc_now()),
                ..Default::default()
            })
            .filter(dns_zones::Column::Id.eq(zone_row_id))
            .filter(dns_zones::Column::DomainId.eq(id))
            .exec(&db)
            .await?;
        return Ok(());
    }
    let row = dns_zones::ActiveModel {
        id: Set(zone_row_id.to_owned()),
        domain_id: Set(id.to_owned()),
        name: Set(full.to_owned()),
        status: Set(HostDnsZoneStatus::Pending),
        provider: Set(provider),
        external_zone_id: Set(Some(zone.id.clone())),
        external_nameservers: Set(Some(json!(zone.nameservers))),
        ..Default::default()
    };
    dns_zones::Entity::insert(row)
        .exec_without_returning(&db)
        .await?;
    Ok(())
}

/// `update dns_zones set … where id = $1`.
async fn update_zone(db: &PgPool, zone_id: &str, row: dns_zones::ActiveModel) -> Result<(), DbErr> {
    dns_zones::Entity::update_many()
        .set(row)
        .filter(dns_zones::Column::Id.eq(zone_id))
        .exec(&orm(db))
        .await?;
    Ok(())
}

#[allow(clippy::too_many_lines)] // the zone, the outside-EU check, the read and the writes
async fn refresh_zone_status(
    State(state): State<HostState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let providers = caller.providers(&state);
    let result: Result<Response, DbErr> = async {
        let Some((domain, zone)) = domain_with_zone(&caller.db, &id).await? else {
            return Ok(ApiError::not_found("Domain", Some(&id)).into_response());
        };
        let zone_dns = providers.zone_dns(zone.as_ref());
        let (zone, provider, dns) = match (zone, zone_dns) {
            (Some(zone), ZoneDns::Ready(provider, dns)) => (zone, provider, dns),
            (_, ZoneDns::Unconfigured(provider)) => {
                return Ok(ApiError::internal()
                    .with_message(format!(
                        "{} integration is not configured.",
                        provider.label()
                    ))
                    .into_response());
            }
            _ => {
                return Ok(ApiError::bad_request(format!(
                    "This domain does not have a {} zone yet.",
                    providers.dns_provider.label()
                ))
                .into_response());
            }
        };
        if let Err(refusal) = dns_allowed(&caller.db, provider).await {
            return Ok(refusal);
        }
        let label = provider.label();
        let external = text(&zone, "externalZoneId").unwrap_or_default().to_owned();
        let zone_id = text(&zone, "id").unwrap_or_default().to_owned();
        let domain_status = text(&domain, "status").unwrap_or_default().to_owned();
        let cf_zone = match dns.get_zone(&external).await {
            Ok(cf_zone) => cf_zone,
            Err(error) => {
                tracing::error!(%error, "[domains.service] get {label} zone failed");
                return Ok(error_response(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "SERVICE_UNAVAILABLE",
                    &format!("Could not reach {label}. Try again in a moment."),
                ));
            }
        };
        let Some(cf_zone) = cf_zone else {
            let at = utc_now();
            let row = dns_zones::ActiveModel {
                status: Set(HostDnsZoneStatus::Error),
                sync_error: Set(Some(format!("Zone no longer exists on {label}"))),
                synced_at: Set(Some(at)),
                updated_at: Set(at),
                ..Default::default()
            };
            update_zone(&caller.db, &zone_id, row).await?;
            return Ok(Data(json!({
                "zoneStatus": "error",
                "domainStatus": domain_status,
                "cloudflareStatus": null,
            }))
            .into_response());
        };
        let (next, next_status) = match cf_zone.status.as_str() {
            "active" => ("active", HostDnsZoneStatus::Active),
            "pending" | "initializing" => ("pending", HostDnsZoneStatus::Pending),
            _ => ("error", HostDnsZoneStatus::Error),
        };
        if Some(next) != text(&zone, "status") {
            let at = utc_now();
            let row = dns_zones::ActiveModel {
                status: Set(next_status),
                external_nameservers: Set(Some(json!(cf_zone.nameservers))),
                synced_at: Set(Some(at)),
                sync_error: Set(
                    (next == "error").then(|| format!("{label} status: {}", cf_zone.status))
                ),
                updated_at: Set(at),
                ..Default::default()
            };
            update_zone(&caller.db, &zone_id, row).await?;
        }
        let mut status = domain_status;
        if is_external_registrar(text(&domain, "registrar"))
            && next == "active"
            && status == "pending"
        {
            "active".clone_into(&mut status);
            domains::Entity::update_many()
                .set(domains::ActiveModel {
                    status: Set(HostDomainStatus::Active),
                    nameservers: Set(Some(json!(cf_zone.nameservers))),
                    updated_at: Set(utc_now()),
                    ..Default::default()
                })
                .filter(domains::Column::Id.eq(&id))
                .exec(&orm(&caller.db))
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

async fn auth_code(
    State(state): State<HostState>,
    caller: Caller,
    Path(id): Path<String>,
) -> Response {
    let providers = caller.providers(&state);
    let result: Result<Response, DbErr> = async {
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
        let expires_at = OffsetDateTime::now_utc() + Duration::days(7);
        let expires = iso_timestamp(expires_at);
        domains::Entity::update_many()
            .set(domains::ActiveModel {
                auth_code: Set(Some(code.clone())),
                auth_code_expires_at: Set(Some(utc_timestamp(expires_at))),
                updated_at: Set(utc_now()),
                ..Default::default()
            })
            .filter(domains::Column::Id.eq(&id))
            .exec(&orm(&caller.db))
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
            if error.is_null() {
                String::new()
            } else {
                as_text(error)
            }
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
) -> Result<Option<Value>, DbErr> {
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
            let row = domains::ActiveModel {
                registration_status: Set(Some(HostDomainRegistrationStatus::RegistrationFailed)),
                status: Set(HostDomainStatus::Cancelled),
                updated_at: Set(utc_now()),
                ..Default::default()
            };
            update_returning(db, id, row).await
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
            let expires = expires.map(|iso| timestamp_of(&iso)).transpose()?;
            let at = utc_now();
            let row = domains::ActiveModel {
                status: Set(HostDomainStatus::Active),
                registration_status: Set(Some(HostDomainRegistrationStatus::Registered)),
                external_registrar_id: Set(Some(remote.id.clone())),
                registrar_status: Set(Some(remote.status.join(","))),
                registered_at: Set(Some(at)),
                expires_at: Set(expires),
                locked: Set(Some(remote.locked)),
                privacy_protection: Set(Some(remote.privacy_protect)),
                registrar_synced_at: Set(Some(at)),
                updated_at: Set(at),
                ..Default::default()
            };
            update_returning(db, id, row).await
        }
    }
}

/// `pollRenewalProcess`: drive a pending renewal's process.
pub(crate) async fn poll_renewal(
    db: &PgPool,
    rtr: &RealtimeRegistrar,
    id: &str,
) -> Result<Option<Value>, DbErr> {
    let Some(domain) = live_domain(db, id).await? else {
        return Ok(None);
    };
    if text(&domain, "registrationStatus") != Some("pending_renewal") {
        return Ok(Some(domain));
    }
    let raw = domain
        .get("metadata")
        .and_then(|m| m.get("rtrRenewalProcessId"));
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
            metadata.insert(
                "error".to_owned(),
                json!("Registrar renewal process failed"),
            );
            let row = domains::ActiveModel {
                registration_status: Set(Some(HostDomainRegistrationStatus::Failed)),
                metadata: Set(Some(Value::Object(metadata))),
                updated_at: Set(utc_now()),
                ..Default::default()
            };
            update_returning(db, id, row).await
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
            let expires = expires.map(|iso| timestamp_of(&iso)).transpose()?;
            let at = utc_now();
            let mut row = domains::ActiveModel {
                status: Set(HostDomainStatus::Active),
                registration_status: Set(Some(HostDomainRegistrationStatus::Renewed)),
                renewed_at: Set(Some(at)),
                registrar_status: Set(Some(remote.status.join(","))),
                registrar_synced_at: Set(Some(at)),
                metadata: Set(Some(Value::Object(metadata))),
                updated_at: Set(at),
                ..Default::default()
            };
            if let Some(expires) = expires {
                row.expires_at = Set(Some(expires));
            }
            update_returning(db, id, row).await
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
    let result: Result<Response, DbErr> = async {
        if any_domain(&caller.db, &id).await?.is_none() {
            return Ok(ApiError::not_found("Domain registration", Some(&id)).into_response());
        }
        let at = utc_now();
        let mut row = domains::ActiveModel {
            status: Set(HostDomainStatus::Active),
            registration_status: Set(Some(HostDomainRegistrationStatus::Registered)),
            registered_at: Set(Some(at)),
            updated_at: Set(at),
            ..Default::default()
        };
        // `coalesce($contact, registrant_contact)`.
        if let Some(contact) = contact {
            row.registrant_contact = Set(Some(contact));
        }
        domains::Entity::update_many()
            .set(row)
            .filter(domains::Column::Id.eq(&id))
            .exec(&orm(&caller.db))
            .await?;
        let Some(row) = any_domain(&caller.db, &id).await? else {
            return Ok(ApiError::not_found("Domain registration", Some(&id)).into_response());
        };
        caller.publish(&state, DOMAIN_UPDATED, &id, &domain_event(&id, &row));
        Ok(
            Data(json!({ "success": true, "domainId": id, "domain": public_domain(row) }))
                .into_response(),
        )
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
        assert_eq!(
            apply_markup(Some(2000.0), Some(&pricing), Some("eur")),
            Some(1429.0)
        );
        assert_eq!(
            apply_markup(Some(2000.0), Some(&pricing), Some("usd")),
            Some(2200.0)
        );
        assert_eq!(apply_markup(None, None, None), None);
        assert!(is_fqdn("example.com"));
        assert!(!is_fqdn("-example.com"));
        assert!(!is_fqdn("example"));
        assert!(!is_fqdn("Example.com"));
        assert!(is_reserved_domain("brand.example"));
        assert!(is_reserved_domain("printer.local"));
        assert!(!is_reserved_domain("brand.shop"));
        assert!(!is_reserved_domain("example.com"));
        assert!(!is_reserved_domain("-bad.test"));
        assert!(!is_reserved_domain(&format!("{}.test", "a".repeat(250))));
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
