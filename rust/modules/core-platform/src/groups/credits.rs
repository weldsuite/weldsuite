//! `/api/credits` (`app-api/src/routes/credits`): the prepaid credits wallet,
//! in the master database, scoped by `workspaces.id`.
//!
//! The answers keep api-worker's `{ success, data }` envelope, and its
//! errors are `{ error, message }` (not the API's `{ error: { code } }`).
//! The reads take no permission (the session and the workspace are enough);
//! nothing here writes the balance: grants come from billing-worker only,
//! consumption from the workers that run the metered service. The one write
//! is `getOrCreateWorkspaceCredits`'s first-read row (`@weldsuite/credits`).
//!
//! `POST /checkout` (`billing:manage`) starts a Stripe Checkout for a credit
//! package through billing-worker. Billing is Global-only: here the
//! permission, the partner-managed refusal, the body and the org are checked
//! as the workers do, and the call itself answers as the workers do when
//! billing-worker cannot be reached.

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use http::{HeaderMap, StatusCode};
use serde_json::{Map, Value, json};
use time::{Date, Duration, Month, OffsetDateTime, PrimitiveDateTime, Time};
use weldsuite_db::{PgPool, js_row};
use weldsuite_kit::validation::{Format, Issues, Number, Presence, Text};
use weldsuite_kit::{ApiError, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::{Caller, CorePlatformState, PlatformError, answer, validate, validate_query};

/// `LOW_BALANCE_THRESHOLD` (`@weldsuite/credits`).
const LOW_BALANCE_THRESHOLD: i64 = 100;

/// What the workers answer when billing-worker cannot be reached: the
/// `fetch` failure's message (`TypeError: fetch failed`), as a 500.
const BILLING_UNREACHABLE: &str = "fetch failed";

/// The platform origins a checkout may return to (`PLATFORM_CHECKOUT_ORIGINS`
/// in `@weldsuite/app-api-client/schemas/credits`).
const PLATFORM_CHECKOUT_ORIGINS: [&str; 6] = [
    "https://app.weldsuite.org",
    "https://app-test.weldsuite.org",
    "https://app-preview.weldsuite.org",
    "http://localhost:3000",
    "http://localhost:3001",
    "http://localhost:5173",
];

const CHECKOUT_URL_MESSAGE: &str =
    "URL must use an allowed platform origin (app.weldsuite.org or local Vite ports)";

pub(crate) fn router<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<CorePlatformState>
where
    Q: PermissionQueries + 'static,
{
    Router::new()
        .route("/balance", get(balance))
        .route("/transactions", get(transactions))
        .route("/check", post(check))
        .route("/packages", get(packages))
        .route("/rates", get(rates))
        .route("/usage", get(usage))
        .route("/subscription", get(subscription))
        .route(
            "/checkout",
            post(checkout).route_layer(gate.require(["billing:manage"])),
        )
}

// ── the envelope ────────────────────────────────────────────────────────────

/// `c.json({ success: true, data, ...extra })`.
fn ok(data: Value) -> Response {
    let mut body = Map::new();
    body.insert("success".to_owned(), Value::Bool(true));
    body.insert("data".to_owned(), data);
    Json(Value::Object(body)).into_response()
}

/// `c.json({ error, message }, status)`: api-worker's error shape.
fn refuse(status: StatusCode, error: &str, message: &str) -> Response {
    (status, Json(json!({ "error": error, "message": message }))).into_response()
}

/// The 403 without a workspace.
fn org_required() -> Response {
    refuse(
        StatusCode::FORBIDDEN,
        "org_required",
        "Organization context required",
    )
}

/// A failed read: logged, a 500 with the route's message.
fn failed(message: &str, error: &dyn std::fmt::Display) -> Response {
    tracing::error!(%error, "credits: {message}");
    refuse(StatusCode::INTERNAL_SERVER_ERROR, "internal_error", message)
}

/// A JavaScript number as `JSON.stringify` writes it (`20`, not `20.0`).
fn js_number(number: f64) -> Value {
    #[allow(clippy::cast_possible_truncation)]
    if number.is_finite() && number.fract() == 0.0 && number.abs() < 9.0e15 {
        json!(number as i64)
    } else if number.is_finite() {
        json!(number)
    } else {
        Value::Null
    }
}

/// `String(number)` for a finite JavaScript number.
fn js_number_text(number: f64) -> String {
    js_number(number).to_string()
}

/// `Math.round`: halves go up.
fn js_round(number: f64) -> f64 {
    let floor = number.floor();
    if number - floor >= 0.5 {
        floor + 1.0
    } else {
        floor
    }
}

/// A number column of a [`js_row`] (`|| 0` reads null as 0).
fn int(row: &Value, key: &str) -> i64 {
    row.get(key).and_then(Value::as_i64).unwrap_or(0)
}

// ── the wallet row ──────────────────────────────────────────────────────────

/// The first instants of this UTC month and the next, as `toISOString()`.
fn current_period(now: OffsetDateTime) -> (String, String) {
    let year = now.year();
    let month = now.month();
    let (next_year, next_month) = if month == Month::December {
        (year + 1, Month::January)
    } else {
        (year, month.next())
    };
    let first =
        |year: i32, month: Month| format!("{year:04}-{:02}-01T00:00:00.000Z", u8::from(month));
    (first(year, month), first(next_year, next_month))
}

/// `getOrCreateWorkspaceCredits(masterDb, workspaceId)`: the wallet row,
/// created empty for this month on the first read (a concurrent creator wins
/// on the unique `workspace_id`; the row is read again after).
async fn wallet(master: &PgPool, workspace_id: &str) -> Result<Value, sqlx::Error> {
    const SELECT: &str =
        "select to_jsonb(c) from workspace_credits c where c.workspace_id = $1 limit 1";
    let existing: Option<Value> = sqlx::query_scalar(SELECT)
        .bind(workspace_id)
        .fetch_optional(master)
        .await?;
    if let Some(row) = existing {
        return Ok(js_row(row));
    }
    let (start, end) = current_period(OffsetDateTime::now_utc());
    let id = generate_id("wcr");
    sqlx::query(
        "insert into workspace_credits
           (id, workspace_id, current_balance, plan_credits, subscribed_credits,
            monthly_allocation, rolled_over_credits, rollover_cap, period_start, period_end,
            last_reset_at)
         values ($1, $2, 0, 0, 0, 0, 0, null, $3::timestamptz, $4::timestamptz, null)
         on conflict do nothing",
    )
    .bind(&id)
    .bind(workspace_id)
    .bind(&start)
    .bind(&end)
    .execute(master)
    .await?;
    let row: Option<Value> = sqlx::query_scalar(SELECT)
        .bind(workspace_id)
        .fetch_optional(master)
        .await?;
    Ok(row.map_or_else(
        || {
            json!({
                "id": id, "workspaceId": workspace_id, "currentBalance": 0, "planCredits": 0,
                "subscribedCredits": 0, "monthlyAllocation": 0, "rolledOverCredits": 0,
                "rolloverCap": null, "periodStart": start, "periodEnd": end, "lastResetAt": null,
            })
        },
        js_row,
    ))
}

/// The milliseconds since the epoch of a [`js_row`] timestamp
/// (`2026-10-01T00:00:00.000Z`).
fn epoch_millis(iso: &str) -> Option<i128> {
    let part = |range: std::ops::Range<usize>| iso.get(range)?.parse::<u16>().ok();
    if iso.len() != 24 || !iso.ends_with('Z') {
        return None;
    }
    let date = Date::from_calendar_date(
        i32::from(part(0..4)?),
        Month::try_from(u8::try_from(part(5..7)?).ok()?).ok()?,
        u8::try_from(part(8..10)?).ok()?,
    )
    .ok()?;
    let time = Time::from_hms_milli(
        u8::try_from(part(11..13)?).ok()?,
        u8::try_from(part(14..16)?).ok()?,
        u8::try_from(part(17..19)?).ok()?,
        part(20..23)?,
    )
    .ok()?;
    Some(
        PrimitiveDateTime::new(date, time)
            .assume_utc()
            .unix_timestamp_nanos()
            / 1_000_000,
    )
}

/// `Math.max(0, Math.ceil((periodEnd - now) / day))`.
fn days_remaining(period_end: Option<&str>) -> Value {
    let Some(end) = period_end.and_then(epoch_millis) else {
        return Value::Null;
    };
    let now = OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000;
    #[allow(clippy::cast_precision_loss)]
    let days = ((end - now) as f64 / 86_400_000.0).ceil();
    js_number(days.max(0.0))
}

/// The workspace of the request, or `None` (the 403).
fn workspace_of(caller: &Caller) -> Option<&str> {
    Some(caller.workspace_id.as_str()).filter(|id| !id.is_empty())
}

// ── GET /balance ────────────────────────────────────────────────────────────

async fn balance(State(state): State<CorePlatformState>, caller: Caller) -> Response {
    let Some(workspace) = workspace_of(&caller) else {
        return org_required();
    };
    let credits = match wallet(&caller.master(&state), workspace).await {
        Ok(credits) => credits,
        Err(error) => return failed("Failed to fetch balance", &error),
    };
    let current = int(&credits, "currentBalance");
    let monthly = int(&credits, "monthlyAllocation");
    let rolled = int(&credits, "rolledOverCredits");
    let usage = if monthly > 0 {
        #[allow(clippy::cast_precision_loss)]
        let used = (monthly - current + rolled) as f64 / monthly as f64 * 100.0;
        js_round(used)
    } else {
        0.0
    };
    ok(json!({
        "currentBalance": credits["currentBalance"],
        "planCredits": int(&credits, "planCredits"),
        "subscribedCredits": int(&credits, "subscribedCredits"),
        "monthlyAllocation": credits["monthlyAllocation"],
        "rolledOverCredits": credits["rolledOverCredits"],
        "periodStart": credits["periodStart"],
        "periodEnd": credits["periodEnd"],
        "daysRemaining": days_remaining(credits["periodEnd"].as_str()),
        "usagePercentage": js_number(usage.clamp(0.0, 100.0)),
        "isLow": current < LOW_BALANCE_THRESHOLD,
        "isExhausted": current <= 0,
    }))
}

// ── GET /transactions ───────────────────────────────────────────────────────

struct TransactionsQuery {
    page: f64,
    page_size: f64,
    kind: Option<String>,
    service_type: Option<String>,
    from: Option<String>,
    to: Option<String>,
}

fn read_transactions_query(issues: &mut Issues, values: &Map<String, Value>) -> TransactionsQuery {
    let coerce = |min: Option<f64>, max: Option<f64>| Number {
        coerce: true,
        min,
        max,
        ..Number::default()
    };
    let page = issues.number(values, "page", Presence::Optional, coerce(Some(1.0), None));
    let page_size = issues.number(
        values,
        "pageSize",
        Presence::Optional,
        coerce(Some(1.0), Some(100.0)),
    );
    let mut text = |key: &str| {
        issues
            .text(values, key, Presence::Optional, None, None)
            .into_option()
            // `if (type)`: an empty filter is no filter.
            .filter(|value| !value.is_empty())
    };
    let kind = text("type");
    let service_type = text("serviceType");
    let from = text("from");
    let to = text("to");
    TransactionsQuery {
        page: page.into_option().unwrap_or(1.0),
        page_size: page_size.into_option().unwrap_or(20.0),
        kind,
        service_type,
        from,
        to,
    }
}

/// `new Date(text)` for the ISO forms (`2026-10-01`, `2026-10`,
/// `2026-10-01T10:00:00.000Z`, `…+02:00`) as `toISOString()`, days past the
/// month's end rolling over as JavaScript's do. A time without an offset is
/// UTC (the Workers runtime's zone). `None` for anything else.
fn js_date(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let digits = |range: std::ops::Range<usize>| -> Option<u32> {
        let part = text.get(range)?;
        if part.bytes().all(|b| b.is_ascii_digit()) {
            part.parse().ok()
        } else {
            None
        }
    };
    let year = i32::try_from(digits(0..4)?).ok()?;
    let mut at = 4;
    let mut month = 1;
    let mut day = 1;
    if bytes.get(at) == Some(&b'-') {
        month = digits(at + 1..at + 3)?;
        at += 3;
        if bytes.get(at) == Some(&b'-') {
            day = digits(at + 1..at + 3)?;
            at += 3;
        }
    }
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let mut millis: i64 = 0;
    if at < bytes.len() {
        if bytes[at] != b'T' || at != 10 {
            return None;
        }
        let hour = digits(11..13)?;
        if bytes.get(13) != Some(&b':') {
            return None;
        }
        let minute = digits(14..16)?;
        at = 16;
        let mut second = 0;
        let mut fraction = 0;
        if bytes.get(at) == Some(&b':') {
            second = digits(at + 1..at + 3)?;
            at += 3;
            if bytes.get(at) == Some(&b'.') {
                let end = text[at + 1..]
                    .find(|c: char| !c.is_ascii_digit())
                    .map_or(text.len(), |n| at + 1 + n);
                if end == at + 1 {
                    return None;
                }
                let ms: String = text[at + 1..end]
                    .chars()
                    .chain("00".chars())
                    .take(3)
                    .collect();
                fraction = ms.parse::<u32>().ok()?;
                at = end;
            }
        }
        if minute > 59 || second > 59 || hour > 24 || (hour == 24 && minute + second + fraction > 0)
        {
            return None;
        }
        let offset = match &text[at..] {
            "" | "Z" => 0,
            zone => {
                let sign = match zone.as_bytes()[0] {
                    b'+' => 1,
                    b'-' => -1,
                    _ => return None,
                };
                let rest = zone[1..].replace(':', "");
                if rest.len() != 4 || zone[1..].len() > 5 {
                    return None;
                }
                let hours = digits_of(&rest[..2])?;
                let minutes = digits_of(&rest[2..])?;
                if hours > 23 || minutes > 59 {
                    return None;
                }
                sign * i64::from(hours * 60 + minutes)
            }
        };
        millis =
            i64::from(((hour * 60 + minute) * 60 + second) * 1000 + fraction) - offset * 60_000;
    }
    let first =
        Date::from_calendar_date(year, Month::try_from(u8::try_from(month).ok()?).ok()?, 1).ok()?;
    let at = PrimitiveDateTime::new(first, Time::MIDNIGHT).assume_utc()
        + Duration::days(i64::from(day) - 1)
        + Duration::milliseconds(millis);
    Some(format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        at.year(),
        u8::from(at.month()),
        at.day(),
        at.hour(),
        at.minute(),
        at.second(),
        at.millisecond()
    ))
}

fn digits_of(text: &str) -> Option<u32> {
    if text.bytes().all(|b| b.is_ascii_digit()) {
        text.parse().ok()
    } else {
        None
    }
}

/// A whole number `limit`/`offset` Postgres takes; the workers' query fails
/// on anything else.
#[allow(clippy::cast_possible_truncation)]
fn bigint(number: f64) -> Option<i64> {
    (number.is_finite() && number.fract() == 0.0 && number.abs() < 9.0e15).then_some(number as i64)
}

async fn transactions(
    State(state): State<CorePlatformState>,
    caller: Caller,
    RawQuery(query): RawQuery,
) -> Response {
    const FAILED: &str = "Failed to fetch transactions";
    let query = match validate_query(query.as_deref(), read_transactions_query) {
        Ok(query) => query,
        Err(error) => return error.respond(),
    };
    let Some(workspace) = workspace_of(&caller) else {
        return org_required();
    };
    let master = caller.master(&state);
    let (from, to) = match (
        query.from.as_deref().map(js_date),
        query.to.as_deref().map(js_date),
    ) {
        (Some(None), _) | (_, Some(None)) => return failed(FAILED, &"Invalid time value"),
        (from, to) => (from.flatten(), to.flatten()),
    };
    let count: Result<Option<i32>, sqlx::Error> = sqlx::query_scalar(
        "select count(*)::int from credit_transactions t
         where t.workspace_id = $1
           and ($2::text is null or t.type = $2::text)
           and ($3::text is null or t.service_type = $3::text)
           and ($4::timestamptz is null or t.created_at >= $4::timestamptz)
           and ($5::timestamptz is null or t.created_at <= $5::timestamptz)",
    )
    .bind(workspace)
    .bind(&query.kind)
    .bind(&query.service_type)
    .bind(&from)
    .bind(&to)
    .fetch_one(&master)
    .await;
    let total = match count {
        Ok(count) => f64::from(count.unwrap_or(0)),
        Err(error) => return failed(FAILED, &error),
    };
    let total_pages = (total / query.page_size).ceil();
    let offset = (query.page - 1.0) * query.page_size;
    let (Some(limit), Some(offset)) = (bigint(query.page_size), bigint(offset)) else {
        return failed(FAILED, &"limit or offset is not a whole number");
    };
    let rows: Result<Vec<Value>, sqlx::Error> = sqlx::query_scalar(
        "select to_jsonb(t) || jsonb_build_object('amount_paid', t.amount_paid::text)
         from credit_transactions t
         where t.workspace_id = $1
           and ($2::text is null or t.type = $2::text)
           and ($3::text is null or t.service_type = $3::text)
           and ($4::timestamptz is null or t.created_at >= $4::timestamptz)
           and ($5::timestamptz is null or t.created_at <= $5::timestamptz)
         order by t.created_at desc
         limit $6 offset $7",
    )
    .bind(workspace)
    .bind(&query.kind)
    .bind(&query.service_type)
    .bind(&from)
    .bind(&to)
    .bind(limit)
    .bind(offset)
    .fetch_all(&master)
    .await;
    let rows = match rows {
        Ok(rows) => rows.into_iter().map(js_row).collect::<Vec<_>>(),
        Err(error) => return failed(FAILED, &error),
    };
    Json(json!({
        "success": true,
        "data": rows,
        "pagination": {
            "page": js_number(query.page),
            "pageSize": js_number(query.page_size),
            "totalCount": js_number(total),
            "totalPages": js_number(total_pages),
            "hasMore": query.page < total_pages,
        },
    }))
    .into_response()
}

// ── POST /check ─────────────────────────────────────────────────────────────

async fn check(
    State(state): State<CorePlatformState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let amount = match validate(&headers, &body, |issues, body| {
        let rules = Number {
            min: Some(1.0),
            ..Number::default()
        };
        issues
            .number(body, "amount", Presence::Required, rules)
            .into_option()
            .unwrap_or_default()
    }) {
        Ok(amount) => amount,
        Err(error) => return error.respond(),
    };
    let Some(workspace) = workspace_of(&caller) else {
        return org_required();
    };
    let credits = match wallet(&caller.master(&state), workspace).await {
        Ok(credits) => credits,
        Err(error) => return failed("Failed to check availability", &error),
    };
    #[allow(clippy::cast_precision_loss)]
    let current = int(&credits, "currentBalance") as f64;
    let available = current >= amount;
    let shortfall = if available { 0.0 } else { amount - current };
    let mut data = json!({
        "available": available,
        "currentBalance": credits["currentBalance"],
        "required": js_number(amount),
        "shortfall": js_number(shortfall),
    });
    if !available {
        data["message"] = Value::String(format!(
            "Insufficient credits. You need {} more credits.",
            js_number_text(shortfall)
        ));
    }
    ok(data)
}

// ── GET /packages ───────────────────────────────────────────────────────────

type PackageRow = (
    String,
    String,
    Option<String>,
    i32,
    String,
    String,
    Option<String>,
    Option<i32>,
);

async fn packages(State(state): State<CorePlatformState>, caller: Caller) -> Response {
    let rows: Result<Vec<PackageRow>, sqlx::Error> = sqlx::query_as(
        "select id, name, description, credits, price::text, currency, stripe_price_id, is_popular
         from credit_packages where is_active = 1 order by sort_order",
    )
    .fetch_all(&caller.master(&state))
    .await;
    let rows = match rows {
        Ok(rows) => rows,
        Err(error) => return failed("Failed to fetch packages", &error),
    };
    let data: Vec<Value> = rows
        .into_iter()
        .map(
            |(id, name, description, credits, price, currency, stripe_price_id, popular)| {
                json!({
                    "id": id,
                    "name": name,
                    "description": description,
                    "credits": credits,
                    // `Number(p.price)`.
                    "price": js_number(price.parse::<f64>().unwrap_or(f64::NAN)),
                    "currency": currency,
                    "stripePriceId": stripe_price_id,
                    "isPopular": popular == Some(1),
                })
            },
        )
        .collect();
    ok(Value::Array(data))
}

// ── GET /rates ──────────────────────────────────────────────────────────────

/// `DEFAULT_CREDIT_RATES`.
fn default_rates() -> Map<String, Value> {
    json!({
        "aiTokens": 1,
        "parcelLabel": 10,
        "meetingBotMinute": 2,
        "callTranscriptionMinute": 2,
        "voipCallMinute": 3,
        "transcriptionProvider": "assemblyai",
        "hunterEmailFinder": 2,
        "hunterEmailVerifier": 1,
        "hunterDomainSearch": 5,
    })
    .as_object()
    .cloned()
    .unwrap_or_default()
}

/// The plan's `features.creditRates` over the defaults; `Err` falls back to
/// the defaults as the workers' `catch` does.
async fn plan_rates(master: &PgPool, workspace: &str) -> Result<Map<String, Value>, sqlx::Error> {
    let mut rates = default_rates();
    let plan: Option<Option<String>> =
        sqlx::query_scalar("select plan_id from workspaces where id = $1")
            .bind(workspace)
            .fetch_optional(master)
            .await?;
    let Some(plan) = plan.flatten().filter(|id| !id.is_empty()) else {
        return Ok(rates);
    };
    let features: Option<Option<Value>> =
        sqlx::query_scalar("select features from plans where id = $1")
            .bind(&plan)
            .fetch_optional(master)
            .await?;
    let features = features.flatten().unwrap_or(Value::Null);
    match features.get("creditRates") {
        Some(Value::Object(custom)) => {
            for (key, value) in custom {
                rates.insert(key.clone(), value.clone());
            }
        }
        // `{ ...array }` spreads the items by index.
        Some(Value::Array(items)) => {
            for (index, value) in items.iter().enumerate() {
                rates.insert(index.to_string(), value.clone());
            }
        }
        _ => {}
    }
    Ok(rates)
}

async fn rates(State(state): State<CorePlatformState>, caller: Caller) -> Response {
    let Some(workspace) = workspace_of(&caller) else {
        return org_required();
    };
    match plan_rates(&caller.master(&state), workspace).await {
        Ok(rates) => ok(Value::Object(rates)),
        Err(error) => {
            tracing::error!(%error, "credits: rates failed");
            ok(Value::Object(default_rates()))
        }
    }
}

// ── GET /usage ──────────────────────────────────────────────────────────────

/// A service's consumption this period: service, credits, transactions.
type UsageRow = (Option<String>, Option<i32>, Option<i32>);

async fn usage(State(state): State<CorePlatformState>, caller: Caller) -> Response {
    const FAILED: &str = "Failed to fetch usage";
    let Some(workspace) = workspace_of(&caller) else {
        return org_required();
    };
    let master = caller.master(&state);
    let credits = match wallet(&master, workspace).await {
        Ok(credits) => credits,
        Err(error) => return failed(FAILED, &error),
    };
    let rows: Result<Vec<UsageRow>, sqlx::Error> = sqlx::query_as(
        "select service_type, sum(abs(amount))::int, count(*)::int
             from credit_transactions
             where workspace_id = $1 and type = 'consumption' and created_at >= $2::timestamptz
             group by service_type",
    )
    .bind(workspace)
    .bind(credits["periodStart"].as_str())
    .fetch_all(&master)
    .await;
    let rows = match rows {
        Ok(rows) => rows,
        Err(error) => return failed(FAILED, &error),
    };
    let mut by_service = Map::new();
    let mut consumed: i64 = 0;
    for (service, total, count) in rows {
        let Some(service) = service.filter(|s| !s.is_empty()) else {
            continue;
        };
        let total = i64::from(total.unwrap_or(0));
        by_service.insert(
            service,
            json!({ "credits": total, "count": count.unwrap_or(0) }),
        );
        consumed += total;
    }
    ok(json!({
        "periodStart": credits["periodStart"],
        "periodEnd": credits["periodEnd"],
        "totalAllocated": int(&credits, "monthlyAllocation") + int(&credits, "rolledOverCredits"),
        "totalConsumed": consumed,
        "totalRemaining": credits["currentBalance"],
        "byService": by_service,
    }))
}

// ── GET /subscription ───────────────────────────────────────────────────────

async fn subscription(State(state): State<CorePlatformState>, caller: Caller) -> Response {
    let Some(workspace) = workspace_of(&caller) else {
        return org_required();
    };
    let credits = match wallet(&caller.master(&state), workspace).await {
        Ok(credits) => credits,
        Err(error) => return failed("Failed to fetch subscription credits", &error),
    };
    let mut data = json!({
        "planCredits": int(&credits, "planCredits"),
        "subscribedCredits": int(&credits, "subscribedCredits"),
        "totalMonthly": credits["monthlyAllocation"],
    });
    // A field the row lacks is `undefined`, left out of the JSON.
    for (to, from) in [
        ("stripeItemId", "stripeCreditsItemId"),
        ("stripePriceId", "stripeCreditsPriceId"),
    ] {
        if let Some(value) = credits.get(from) {
            data[to] = value.clone();
        }
    }
    ok(data)
}

// ── POST /checkout ──────────────────────────────────────────────────────────

/// `isAllowedPlatformCheckoutUrl`: an absolute URL on a platform origin.
fn allowed_checkout_url(text: &str) -> bool {
    let Ok(url) = url::Url::parse(text) else {
        return false;
    };
    match url.scheme() {
        "http" if !matches!(url.host_str(), Some("localhost" | "127.0.0.1")) => return false,
        "http" | "https" => {}
        _ => return false,
    }
    PLATFORM_CHECKOUT_ORIGINS.contains(&url.origin().ascii_serialization().as_str())
}

/// `creditTopupCheckoutSchema`: `packageId`, and the two return URLs, each a
/// URL (`.url()`) on a platform origin (`.refine`, settled after the rest).
fn read_checkout(issues: &mut Issues, body: &Map<String, Value>) {
    issues.text(body, "packageId", Presence::Required, Some(1), None);
    let url = Text {
        format: Some(Format::Url),
        ..Text::default()
    };
    for key in ["successUrl", "cancelUrl"] {
        issues.text_with(body, key, Presence::Optional, url);
    }
    for key in ["successUrl", "cancelUrl"] {
        if let Some(Value::String(text)) = body.get(key)
            && !allowed_checkout_url(text)
        {
            issues.custom(key, CHECKOUT_URL_MESSAGE);
        }
    }
}

/// `getManagedContext(...).partner`: the partner billing a partner-managed
/// workspace, as `partnerPublicInfo`.
async fn managing_partner(master: &PgPool, org_ref: &str) -> Result<Option<Value>, sqlx::Error> {
    let partner: Option<Value> = sqlx::query_scalar(
        "select jsonb_build_object(
                  'id', p.id, 'name', p.name, 'logoUrl', p.logo_url,
                  'websiteUrl', p.website_url, 'supportEmail', p.support_email,
                  'supportUrl', p.support_url)
         from workspaces w join partners p on p.id = w.partner_id
         where (w.id = $1 or w.clerk_org_id = $1) and w.billing_mode = 'partner'
         limit 1",
    )
    .bind(org_ref)
    .fetch_optional(master)
    .await?;
    Ok(partner)
}

async fn checkout(
    State(state): State<CorePlatformState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(
        async {
            let org = caller.org_id.clone().filter(|org| !org.is_empty());
            // `blockPartnerManaged()`: a partner workspace's credits come from
            // its licence and its partner, not Stripe.
            if let Some(org) = &org
                && let Some(partner) = managing_partner(&caller.master(&state), org)
                    .await
                    .map_err(PlatformError::from)?
            {
                let name = partner["name"].as_str().unwrap_or_default().to_owned();
                return Err(ApiError::new(
                    StatusCode::FORBIDDEN,
                    "PARTNER_MANAGED",
                    format!(
                        "This workspace is billed by {name}. Contact them to change your subscription."
                    ),
                )
                .with_details(json!({ "partner": partner }))
                .into());
            }
            validate(&headers, &body, read_checkout)?;
            if org.is_none() {
                return Err(ApiError::org_required().into());
            }
            // billing-worker (Stripe Checkout) is Global-only: answer as the
            // workers do when it cannot be reached.
            tracing::warn!("credits: no billing-worker on this edition, checkout refused");
            Err(PlatformError::Response(Box::new(
                ApiError::internal()
                    .with_message(BILLING_UNREACHABLE)
                    .into_response(),
            )))
        }
        .await,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn periods_are_calendar_months_in_utc() {
        let at = |text: &str| {
            let format = time::macros::format_description!("[year]-[month]-[day]T[hour]:[minute]");
            PrimitiveDateTime::parse(text, format)
                .expect("a date")
                .assume_utc()
        };
        assert_eq!(
            current_period(at("2026-10-29T13:00")),
            (
                "2026-10-01T00:00:00.000Z".to_owned(),
                "2026-11-01T00:00:00.000Z".to_owned()
            )
        );
        assert_eq!(
            current_period(at("2026-12-31T23:59")).1,
            "2027-01-01T00:00:00.000Z"
        );
    }

    #[test]
    fn rounding_and_numbers_read_as_javascript_does() {
        assert!((js_round(2.5) - 3.0).abs() < f64::EPSILON);
        assert!((js_round(-2.5) + 2.0).abs() < f64::EPSILON);
        assert!(js_round(0.499_999_999_999_999_94).abs() < f64::EPSILON);
        assert_eq!(js_number(20.0), json!(20));
        assert_eq!(js_number(19.99), json!(19.99));
        assert_eq!(js_number_text(1.5), "1.5");
        assert_eq!(epoch_millis("1970-01-02T00:00:00.001Z"), Some(86_400_001));
    }

    #[test]
    fn dates_parse_like_new_date() {
        assert_eq!(
            js_date("2026-02-30").as_deref(),
            Some("2026-03-02T00:00:00.000Z")
        );
        assert_eq!(
            js_date("2026-01").as_deref(),
            Some("2026-01-01T00:00:00.000Z")
        );
        assert_eq!(js_date("2026").as_deref(), Some("2026-01-01T00:00:00.000Z"));
        assert_eq!(
            js_date("2026-01-01T10:00:00.1234Z").as_deref(),
            Some("2026-01-01T10:00:00.123Z")
        );
        assert_eq!(
            js_date("2026-01-01T10:00:00+01:00").as_deref(),
            Some("2026-01-01T09:00:00.000Z")
        );
        assert_eq!(
            js_date("2026-01-01T10:00:00+0100").as_deref(),
            Some("2026-01-01T09:00:00.000Z")
        );
        assert_eq!(
            js_date("2026-01-01T24:00:00Z").as_deref(),
            Some("2026-01-02T00:00:00.000Z")
        );
        assert_eq!(js_date("garbage"), None);
        assert_eq!(js_date(""), None);
        assert_eq!(js_date("2026-13-01"), None);
    }

    #[test]
    fn checkout_urls_stay_on_platform_origins() {
        assert!(allowed_checkout_url(
            "https://app.weldsuite.org/settings/billing?credits=success"
        ));
        assert!(allowed_checkout_url("http://localhost:5173/x"));
        assert!(!allowed_checkout_url("https://evil.example/x"));
        assert!(!allowed_checkout_url("http://app.weldsuite.org/x"));
        assert!(!allowed_checkout_url("nope"));
    }

    #[test]
    fn checkout_bodies_read_like_zod() {
        // Zod 3.25: the refinements' issues come after every field's checks.
        let body = json!({ "packageId": 5, "successUrl": "nope", "cancelUrl": "nope2" });
        let mut issues = Issues::default();
        read_checkout(&mut issues, body.as_object().expect("an object"));
        let Err(invalid) = issues.finish() else {
            panic!("expected issues");
        };
        let response = invalid.flatten();
        assert_eq!(
            response["fieldErrors"]["successUrl"],
            json!(["Invalid url", CHECKOUT_URL_MESSAGE])
        );
        assert_eq!(
            response["fieldErrors"]["packageId"],
            json!(["Expected string, received number"])
        );
    }
}
