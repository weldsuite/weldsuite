//! The parcel helper routes: `/api/parcel-analytics` (read-only aggregates
//! over parcels, shipments and returns), `/api/parcel-rates` (rates from the
//! stored shipping prices) and `/api/parcel-settings` (the singleton
//! `customSettings.parcel` and carrier credentials).

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use time::OffsetDateTime;
use weldsuite_catalogs::entity_events as ev;
use weldsuite_catalogs::permission_keys as perm;
use weldsuite_events::iso_timestamp;
use weldsuite_kit::validation::{Issues, Number, Presence, Text};
use weldsuite_kit::{ApiError, Data};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::js::{js_date_iso, js_number_value, math_round, number_value};
use crate::tables;
use crate::{Caller, CommerceState, Refusal, now, validate, validate_query};

pub(crate) fn analytics_routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<CommerceState>
where
    Q: PermissionQueries + 'static,
{
    let read = || gate.require([perm::ORDERS_READ]);
    Router::new()
        .route("/", get(overview).route_layer(read()))
        .route("/carrier/{carrier_id}", get(carrier).route_layer(read()))
}

pub(crate) fn rates_routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<CommerceState>
where
    Q: PermissionQueries + 'static,
{
    Router::new()
        .route(
            "/calculate",
            post(calculate).route_layer(gate.require([perm::ORDERS_READ])),
        )
        .route(
            "/select",
            post(select).route_layer(gate.require([perm::ORDERS_UPDATE])),
        )
        .route(
            "/carriers",
            get(rate_carriers).route_layer(gate.require([perm::ORDERS_READ])),
        )
}

pub(crate) fn settings_routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<CommerceState>
where
    Q: PermissionQueries + 'static,
{
    let read = || gate.require([perm::CARRIERS_READ]);
    let update = || gate.require([perm::CARRIERS_UPDATE]);
    Router::new()
        .route("/", get(get_settings).route_layer(read()))
        .route("/", put(put_settings).route_layer(update()))
        .route("/carriers", get(settings_carriers).route_layer(read()))
        .route(
            "/carriers/{id}/credentials",
            put(put_credentials).route_layer(update()),
        )
}

// ── analytics ───────────────────────────────────────────────────────────────

/// The `dateFrom`/`dateTo` window: `new Date(x)` or the default; `None`
/// when a given date is an Invalid Date (Drizzle then throws: the 500).
fn window(date_from: Option<&str>, date_to: Option<&str>) -> Option<(String, String)> {
    let now = OffsetDateTime::now_utc();
    let from = match date_from.filter(|d| !d.is_empty()) {
        Some(text) => js_date_iso(text)?,
        None => iso_timestamp(now - time::Duration::days(30)),
    };
    let to = match date_to.filter(|d| !d.is_empty()) {
        Some(text) => js_date_iso(text)?,
        None => iso_timestamp(now),
    };
    Some((from, to))
}

fn optional_text(issues: &mut Issues, fields: &Map<String, Value>, key: &str) -> Option<String> {
    issues
        .text_with(fields, key, Presence::Optional, Text::default())
        .into_option()
}

async fn overview(
    State(_state): State<CommerceState>,
    caller: Caller,
    RawQuery(query): RawQuery,
) -> Response {
    const FAILED: &str = "Failed to fetch analytics";
    let read = validate_query(query.as_deref(), |issues, fields| {
        (
            optional_text(issues, fields, "dateFrom"),
            optional_text(issues, fields, "dateTo"),
            optional_text(issues, fields, "carrierId"),
        )
    });
    let (date_from, date_to, carrier_id) = match read {
        Ok(read) => read,
        Err(refusal) => return refusal.respond(FAILED),
    };
    let Some((from, to)) = window(date_from.as_deref(), date_to.as_deref()) else {
        return ApiError::internal().with_message(FAILED).into_response();
    };
    // `if (carrierId)`: an empty value is no filter.
    let carrier_id = carrier_id.filter(|c| !c.is_empty());
    match overview_data(&caller, &from, &to, carrier_id.as_deref()).await {
        Ok(data) => Data(data).into_response(),
        Err(error) => Refusal::Database(error).respond(FAILED),
    }
}

async fn overview_data(
    caller: &Caller,
    from: &str,
    to: &str,
    carrier_id: Option<&str>,
) -> Result<Value, sqlx::Error> {
    let statuses: Vec<(Option<String>, i32)> = sqlx::query_as(
        "select status, count(*)::int from parcels where deleted_at is null \
         and created_at >= $1::timestamp and created_at <= $2::timestamp \
         and ($3::text is null or carrier_id = $3) group by status",
    )
    .bind(from)
    .bind(to)
    .bind(carrier_id)
    .fetch_all(&caller.db)
    .await?;
    let shipments: i32 = sqlx::query_scalar(
        "select count(*)::int from shipments where deleted_at is null \
         and created_at >= $1::timestamp and created_at <= $2::timestamp",
    )
    .bind(from)
    .bind(to)
    .fetch_one(&caller.db)
    .await?;
    let returns: i32 = sqlx::query_scalar(
        "select count(*)::int from returns where deleted_at is null \
         and created_at >= $1::timestamp and created_at <= $2::timestamp",
    )
    .bind(from)
    .bind(to)
    .fetch_one(&caller.db)
    .await?;
    let carriers: Vec<(Option<String>, Option<String>, i32, i32)> = sqlx::query_as(
        "select carrier_id, carrier_name, count(*)::int, \
         count(*) filter (where status = 'delivered')::int from parcels \
         where deleted_at is null and created_at >= $1::timestamp and created_at <= $2::timestamp \
         and ($3::text is null or carrier_id = $3) group by carrier_id, carrier_name",
    )
    .bind(from)
    .bind(to)
    .bind(carrier_id)
    .fetch_all(&caller.db)
    .await?;

    let mut counts: Map<String, Value> = Map::new();
    let mut total = 0i64;
    for (status, count) in statuses {
        counts.insert(status.unwrap_or_else(|| "unknown".to_owned()), json!(count));
        total += i64::from(count);
    }
    let count = |key: &str| counts.get(key).and_then(Value::as_i64).unwrap_or(0);
    let now = OffsetDateTime::now_utc();
    let timeline: Vec<Value> = (0..=6)
        .rev()
        .map(|days| {
            let day = now - time::Duration::days(days);
            json!({
                "date": iso_timestamp(day)[..10],
                "parcelsCreated": 0,
                "parcelsDelivered": 0,
                "totalCost": 0,
            })
        })
        .collect();
    Ok(json!({
        "overview": {
            "totalParcels": total,
            "totalShipments": shipments,
            "totalDelivered": count("delivered"),
            "totalInTransit": count("in_transit") + count("shipped"),
            "totalPending": count("pending") + count("draft"),
            "totalReturns": returns,
            "averageDeliveryTime": 0,
        },
        "costs": { "totalShippingCost": 0, "averageShippingCost": 0, "currency": "EUR" },
        "carriers": carriers.into_iter().map(|(id, name, count, delivered)| json!({
            "carrierId": id.unwrap_or_else(|| "unknown".to_owned()),
            "carrierName": name.unwrap_or_else(|| "Unknown".to_owned()),
            "parcelCount": count,
            "deliveredCount": delivered,
            "averageDeliveryTime": 0,
        })).collect::<Vec<_>>(),
        "timeline": timeline,
    }))
}

async fn carrier(
    State(_state): State<CommerceState>,
    caller: Caller,
    Path(carrier_id): Path<String>,
    RawQuery(query): RawQuery,
) -> Response {
    const FAILED: &str = "Failed to fetch carrier performance";
    let read = validate_query(query.as_deref(), |issues, fields| {
        (
            optional_text(issues, fields, "dateFrom"),
            optional_text(issues, fields, "dateTo"),
        )
    });
    let (date_from, date_to) = match read {
        Ok(read) => read,
        Err(refusal) => return refusal.respond(FAILED),
    };
    let Some((from, to)) = window(date_from.as_deref(), date_to.as_deref()) else {
        return ApiError::internal().with_message(FAILED).into_response();
    };
    let stats: Result<(i32, i32, i32), sqlx::Error> = sqlx::query_as(
        "select count(*)::int, count(*) filter (where status = 'delivered')::int, \
         count(*) filter (where status = 'exception' or status = 'failed')::int from parcels \
         where carrier_id = $1 and deleted_at is null \
         and created_at >= $2::timestamp and created_at <= $3::timestamp",
    )
    .bind(&carrier_id)
    .bind(&from)
    .bind(&to)
    .fetch_one(&caller.db)
    .await;
    let (total, delivered, failed) = match stats {
        Ok(stats) => stats,
        Err(error) => return Refusal::Database(error).respond(FAILED),
    };
    let rate = if total > 0 {
        f64::from(delivered) / f64::from(total) * 100.0
    } else {
        0.0
    };
    Data(json!({
        "carrierId": carrier_id,
        "totalParcels": total,
        "deliveredCount": delivered,
        "failedCount": failed,
        "deliveryRate": number_value(math_round(rate * 10.0) / 10.0),
        "averageDeliveryTime": 0,
        "totalCost": 0,
    }))
    .into_response()
}

// ── rates ───────────────────────────────────────────────────────────────────

/// `value || fallback` for a JSON value read as a JavaScript number.
fn or_number(value: Option<&Value>, fallback: f64) -> f64 {
    let n = js_number_value(value);
    if value.is_none_or(|v| !truthy(v)) || n.is_nan() {
        fallback
    } else {
        n
    }
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(text) => !text.is_empty(),
        _ => true,
    }
}

/// `resolveBasePrice`: the flat rate, overridden by the first weight range
/// holding the chargeable weight.
fn base_price(price: &Value, chargeable: f64) -> f64 {
    let flat = price.get("flatRate").filter(|f| f.is_object());
    let mut base = or_number(flat.and_then(|f| f.get("amount")), 0.0);
    if let Some(ranges) = price
        .get("weightRanges")
        .filter(|r| truthy(r))
        .and_then(Value::as_array)
    {
        for range in ranges {
            let min = or_number(range.get("minWeight"), 0.0);
            let max = or_number(range.get("maxWeight"), f64::INFINITY);
            if chargeable >= min && chargeable <= max {
                base = or_number(range.get("price").and_then(|p| p.get("amount")), base);
                break;
            }
        }
    }
    base
}

/// `applyRateSurcharges`.
fn surcharged(price: &Value, base: f64) -> f64 {
    let mut total = base;
    if let Some(markup) = price.get("percentageMarkup").filter(|v| truthy(v)) {
        total *= 1.0 + js_number_value(Some(markup)) / 100.0;
    }
    if let Some(fee) = price
        .get("handlingFee")
        .and_then(|f| f.get("amount"))
        .filter(|v| truthy(v))
    {
        total += js_number_value(Some(fee));
    }
    if let Some(fuel) = price.get("fuelSurcharge").filter(|v| truthy(v)) {
        total *= 1.0 + js_number_value(Some(fuel)) / 100.0;
    }
    total
}

fn positive(issues: &mut Issues, fields: &Map<String, Value>, key: &str) -> f64 {
    crate::positive(issues, fields, key, Presence::Required, false).unwrap_or(0.0)
}

/// `calculateRatesSchema`: the parcel's weight and dimensions.
fn read_rates(issues: &mut Issues, fields: &Map<String, Value>) -> (f64, f64, f64, f64) {
    for side in ["origin", "destination"] {
        issues.nested(fields, side, Presence::Required, |issues, inner| {
            issues.text_with(inner, "country", Presence::Required, Text::default());
            issues.text_with(inner, "postalCode", Presence::Required, Text::default());
        });
    }
    let parcel = issues.nested(fields, "parcel", Presence::Required, |issues, parcel| {
        let weight = issues
            .nested(parcel, "weight", Presence::Required, |issues, weight| {
                let value = positive(issues, weight, "value");
                issues.text_with(weight, "unit", Presence::Optional, Text::default());
                value
            })
            .into_option()
            .unwrap_or(0.0);
        let dims = issues
            .nested(parcel, "dimensions", Presence::Required, |issues, dims| {
                let length = positive(issues, dims, "length");
                let width = positive(issues, dims, "width");
                let height = positive(issues, dims, "height");
                issues.text_with(dims, "unit", Presence::Optional, Text::default());
                (length, width, height)
            })
            .into_option()
            .unwrap_or((0.0, 0.0, 0.0));
        (weight, dims.0, dims.1, dims.2)
    });
    parcel.into_option().unwrap_or((0.0, 0.0, 0.0, 0.0))
}

async fn calculate(
    State(_state): State<CommerceState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const FAILED: &str = "Failed to calculate rates";
    let (weight, length, width, height) = match validate(&headers, &body, read_rates) {
        Ok(read) => read,
        Err(refusal) => return refusal.respond(FAILED),
    };
    let carriers: Result<Vec<Value>, sqlx::Error> = sqlx::query_scalar(concat!(
        "select ",
        row_of!(carriers),
        " from carriers t where t.is_active = true and t.deleted_at is null"
    ))
    .fetch_all(&caller.db)
    .await;
    let prices: Result<Vec<Value>, sqlx::Error> = sqlx::query_scalar(concat!(
        "select ",
        row_of!(shipping_prices),
        " from shipping_prices t where t.is_active = true and t.deleted_at is null"
    ))
    .fetch_all(&caller.db)
    .await;
    let (carriers, prices) = match (carriers, prices) {
        (Ok(c), Ok(p)) => (c, p),
        (Err(error), _) | (_, Err(error)) => return Refusal::Database(error).respond(FAILED),
    };
    let carriers: Vec<Value> = carriers
        .into_iter()
        .map(|row| tables::CARRIERS.js(row))
        .collect();
    let volumetric = length * width * height / 5000.0;
    let chargeable = weight.max(volumetric);
    let mut rates: Vec<(f64, Value)> = Vec::new();
    for row in prices {
        let price = tables::SHIPPING_PRICES.js(row);
        let carrier = carriers
            .iter()
            .find(|c| c.get("id") == price.get("carrierId"));
        let Some(carrier) = carrier else { continue };
        let total = surcharged(&price, base_price(&price, chargeable));
        let service = price
            .get("serviceType")
            .and_then(Value::as_str)
            .unwrap_or("standard")
            .to_owned();
        let amount = math_round(total * 100.0) / 100.0;
        rates.push((
            amount,
            json!({
                "id": format!("{}-{service}", price["id"].as_str().unwrap_or_default()),
                "carrier": carrier["name"],
                "service": service,
                "amount": number_value(amount),
                "currency": price.get("currency").filter(|c| !c.is_null()).cloned().unwrap_or_else(|| json!("EUR")),
            }),
        ));
    }
    // `rates.sort((a, b) => a.amount - b.amount)`: stable.
    rates.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    Data(Value::Array(
        rates.into_iter().map(|(_, rate)| rate).collect(),
    ))
    .into_response()
}

async fn select(
    State(_state): State<CommerceState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const FAILED: &str = "Failed to select rate";
    let read = validate(&headers, &body, |issues, fields| {
        let rate_id = issues
            .text_with(fields, "rateId", Presence::Required, Text::default())
            .into_option();
        let parcel_id = issues
            .text_with(fields, "parcelId", Presence::Required, Text::default())
            .into_option();
        (rate_id.unwrap_or_default(), parcel_id.unwrap_or_default())
    });
    let (rate_id, parcel_id) = match read {
        Ok(read) => read,
        Err(refusal) => return refusal.respond(FAILED),
    };
    match select_rate(&caller, &rate_id, &parcel_id).await {
        Ok(response) => response,
        Err(refusal) => refusal.respond(FAILED),
    }
}

async fn select_rate(caller: &Caller, rate_id: &str, parcel_id: &str) -> Result<Response, Refusal> {
    let (price_id, service_type) = match rate_id.find('-') {
        Some(at) => (&rate_id[..at], Some(&rate_id[at + 1..])),
        None => (rate_id, None),
    };
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        row_of!(shipping_prices),
        " from shipping_prices t where t.id = $1 and t.deleted_at is null limit 1"
    ))
    .bind(price_id)
    .fetch_optional(&caller.db)
    .await?;
    let Some(price) = row.map(|row| tables::SHIPPING_PRICES.js(row)) else {
        return Err(Refusal::not_found("Rate", rate_id));
    };
    let carrier_id = price.get("carrierId").and_then(Value::as_str);
    let carrier_name: Option<String> = match carrier_id.filter(|c| !c.is_empty()) {
        Some(id) => {
            sqlx::query_scalar("select name from carriers where id = $1 limit 1")
                .bind(id)
                .fetch_optional(&caller.db)
                .await?
        }
        None => None,
    };
    let stored_service = price.get("serviceType").and_then(Value::as_str);
    let flat = price.get("flatRate").filter(|f| truthy(f));
    let shipping_cost = flat.map(|flat| {
        json!({
            "amount": flat.get("amount").filter(|a| !a.is_null()).cloned().unwrap_or_else(|| json!(0)),
            "currency": flat.get("currency").filter(|c| !c.is_null()).cloned().unwrap_or_else(|| json!("EUR")),
        })
    });
    let service = service_type.or(stored_service).unwrap_or("standard");
    // `.set({ carrierId: x ?? undefined, carrierName, … })`: undefined keys
    // stay out of the statement.
    sqlx::query(
        "update parcels set \
         carrier_id = case when $1::boolean then $2 else carrier_id end, \
         carrier_name = case when $3::boolean then $4 else carrier_name end, \
         service_type = $5, \
         shipping_cost = case when $6::boolean then $7::jsonb else shipping_cost end, \
         updated_at = $8::timestamp \
         where id = $9 and deleted_at is null",
    )
    .bind(carrier_id.is_some())
    .bind(carrier_id)
    .bind(carrier_name.is_some())
    .bind(carrier_name.as_deref())
    .bind(service)
    .bind(shipping_cost.is_some())
    .bind(shipping_cost.unwrap_or(Value::Null))
    .bind(now())
    .bind(parcel_id)
    .execute(&caller.db)
    .await?;
    let mut out = Map::new();
    out.insert("parcelId".to_owned(), json!(parcel_id));
    out.insert("rateId".to_owned(), json!(rate_id));
    if let Some(name) = carrier_name {
        out.insert("carrier".to_owned(), json!(name));
    }
    out.insert(
        "service".to_owned(),
        match service_type {
            Some(service) => json!(service),
            None => price.get("serviceType").cloned().unwrap_or(Value::Null),
        },
    );
    Ok(Data(Value::Object(out)).into_response())
}

async fn rate_carriers(State(_state): State<CommerceState>, caller: Caller) -> Response {
    let rows: Result<Vec<Value>, sqlx::Error> = sqlx::query_scalar(
        "select jsonb_build_object('id', id, 'name', name, 'code', code, 'logo', logo) \
         from carriers where is_active = true and deleted_at is null",
    )
    .fetch_all(&caller.db)
    .await;
    match rows {
        Ok(rows) => Data(Value::Array(rows)).into_response(),
        Err(error) => Refusal::Database(error).respond("Failed to fetch carriers"),
    }
}

// ── settings ────────────────────────────────────────────────────────────────

async fn custom_settings(caller: &Caller) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Option<Value>> =
        sqlx::query_scalar("select custom_settings from workspace_settings where id = $1 limit 1")
            .bind(&caller.clerk_org_id)
            .fetch_optional(&caller.db)
            .await?;
    Ok(row.map(|custom| custom.unwrap_or_else(|| json!({}))))
}

/// `x ?? fallback` for a stored setting.
fn or_default(parcel: &Value, key: &str, fallback: Value) -> Value {
    parcel
        .get(key)
        .filter(|v| !v.is_null())
        .cloned()
        .unwrap_or(fallback)
}

async fn get_settings(State(_state): State<CommerceState>, caller: Caller) -> Response {
    let custom = match custom_settings(&caller).await {
        Ok(custom) => custom.unwrap_or_else(|| json!({})),
        Err(error) => return Refusal::Database(error).respond("Failed to fetch settings"),
    };
    // `(custom.parcel ?? {})`.
    let parcel = custom
        .get("parcel")
        .filter(|p| !p.is_null())
        .cloned()
        .unwrap_or_else(|| json!({}));
    let mut out = Map::new();
    for key in ["defaultCarrier", "defaultServiceType"] {
        if let Some(value) = parcel.get(key) {
            out.insert(key.to_owned(), value.clone());
        }
    }
    out.insert(
        "autoGenerateLabels".to_owned(),
        or_default(&parcel, "autoGenerateLabels", json!(false)),
    );
    out.insert(
        "autoSendNotifications".to_owned(),
        or_default(&parcel, "autoSendNotifications", json!(true)),
    );
    out.insert(
        "labelFormat".to_owned(),
        or_default(&parcel, "labelFormat", json!("pdf")),
    );
    out.insert(
        "labelSize".to_owned(),
        or_default(&parcel, "labelSize", json!("A6")),
    );
    out.insert(
        "defaultWeight".to_owned(),
        or_default(
            &parcel,
            "defaultWeight",
            json!({ "value": 1, "unit": "kg" }),
        ),
    );
    out.insert(
        "defaultDimensions".to_owned(),
        or_default(
            &parcel,
            "defaultDimensions",
            json!({ "length": 20, "width": 15, "height": 10, "unit": "cm" }),
        ),
    );
    Data(Value::Object(out)).into_response()
}

/// `updateParcelSettingsSchema` (strips unknown keys).
fn read_settings(issues: &mut Issues, fields: &Map<String, Value>) -> Map<String, Value> {
    const OPT: Presence = Presence::Optional;
    let mut out = Map::new();
    let mut keep = |key: &str, value: Option<Value>| {
        if let Some(value) = value {
            out.insert(key.to_owned(), value);
        }
    };
    let text = |issues: &mut Issues, key: &str| {
        issues
            .text_with(fields, key, OPT, Text::default())
            .into_option()
            .map(Value::String)
    };
    keep("defaultCarrier", text(issues, "defaultCarrier"));
    keep("defaultServiceType", text(issues, "defaultServiceType"));
    keep(
        "autoGenerateLabels",
        issues
            .boolean(fields, "autoGenerateLabels", OPT)
            .into_option()
            .map(Value::Bool),
    );
    keep(
        "autoSendNotifications",
        issues
            .boolean(fields, "autoSendNotifications", OPT)
            .into_option()
            .map(Value::Bool),
    );
    keep(
        "labelFormat",
        issues
            .choice(fields, "labelFormat", OPT, &["pdf", "png", "zpl"])
            .into_option()
            .map(Value::String),
    );
    keep("labelSize", text(issues, "labelSize"));
    let number = |issues: &mut Issues, inner: &Map<String, Value>, key: &str| {
        issues
            .number(inner, key, Presence::Required, Number::default())
            .into_option()
            .map(number_value)
    };
    let weight = issues
        .nested(fields, "defaultWeight", OPT, |issues, inner| {
            let mut weight = Map::new();
            if let Some(v) = number(issues, inner, "value") {
                weight.insert("value".to_owned(), v);
            }
            if let Some(v) = issues
                .text_with(inner, "unit", Presence::Required, Text::default())
                .into_option()
            {
                weight.insert("unit".to_owned(), Value::String(v));
            }
            Value::Object(weight)
        })
        .into_option();
    keep("defaultWeight", weight);
    let dims = issues
        .nested(fields, "defaultDimensions", OPT, |issues, inner| {
            let mut dims = Map::new();
            for key in ["length", "width", "height"] {
                if let Some(v) = number(issues, inner, key) {
                    dims.insert(key.to_owned(), v);
                }
            }
            if let Some(v) = issues
                .text_with(inner, "unit", Presence::Required, Text::default())
                .into_option()
            {
                dims.insert("unit".to_owned(), Value::String(v));
            }
            Value::Object(dims)
        })
        .into_option();
    keep("defaultDimensions", dims);
    out
}

async fn put_settings(
    State(state): State<CommerceState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const FAILED: &str = "Failed to update settings";
    let data = match validate(&headers, &body, read_settings) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond(FAILED),
    };
    let existing = match custom_settings(&caller).await {
        Ok(existing) => existing,
        Err(error) => return Refusal::Database(error).respond(FAILED),
    };
    let mut custom = match existing.clone() {
        Some(Value::Object(custom)) => custom,
        _ => Map::new(),
    };
    let mut parcel = match custom.get("parcel") {
        Some(Value::Object(parcel)) => parcel.clone(),
        _ => Map::new(),
    };
    for (key, value) in &data {
        parcel.insert(key.clone(), value.clone());
    }
    custom.insert("parcel".to_owned(), Value::Object(parcel));
    let now = now();
    let written = if existing.is_some() {
        sqlx::query(
            "update workspace_settings set custom_settings = $1, updated_at = $2::timestamptz where id = $3",
        )
        .bind(Value::Object(custom))
        .bind(&now)
        .bind(&caller.clerk_org_id)
        .execute(&caller.db)
        .await
    } else {
        let mut values = Map::new();
        let t = &tables::WORKSPACE_SETTINGS;
        t.set(&mut values, "id", json!(caller.clerk_org_id));
        t.set(&mut values, "customSettings", Value::Object(custom));
        t.set(&mut values, "createdAt", json!(now));
        t.set(&mut values, "updatedAt", json!(now));
        match t
            .insert(&caller.db, values, &["createdAt", "updatedAt"])
            .await
        {
            Ok(_) => Ok(Default::default()),
            Err(error) => {
                tracing::error!(%error, "[commerce-api/parcel-settings] {FAILED}");
                return ApiError::internal().with_message(FAILED).into_response();
            }
        }
    };
    if let Err(error) = written {
        return Refusal::Database(error).respond(FAILED);
    }
    caller.publish(
        &state,
        ev::PARCEL_SETTINGS_UPDATED,
        &caller.clerk_org_id,
        &Value::Object(data),
    );
    Data(json!({ "message": "Settings updated successfully" })).into_response()
}

async fn settings_carriers(State(_state): State<CommerceState>, caller: Caller) -> Response {
    let rows: Result<Vec<Value>, sqlx::Error> = sqlx::query_scalar(concat!(
        "select ",
        row_of!(carriers),
        " from carriers t where t.deleted_at is null"
    ))
    .fetch_all(&caller.db)
    .await;
    let rows = match rows {
        Ok(rows) => rows,
        Err(error) => return Refusal::Database(error).respond("Failed to fetch carrier settings"),
    };
    let out: Vec<Value> = rows
        .into_iter()
        .map(|row| {
            let row = tables::CARRIERS.js(row);
            let mut item = Map::new();
            for key in ["id", "name", "code", "isActive", "integrationType"] {
                item.insert(key.to_owned(), row.get(key).cloned().unwrap_or(Value::Null));
            }
            item.insert(
                "hasApiCredentials".to_owned(),
                json!(row.get("apiCredentials").is_some_and(truthy)),
            );
            for key in ["createdAt", "updatedAt"] {
                if let Some(value) = row.get(key).filter(|v| !v.is_null()) {
                    item.insert(key.to_owned(), value.clone());
                }
            }
            Value::Object(item)
        })
        .collect();
    Data(Value::Array(out)).into_response()
}

async fn put_credentials(
    State(state): State<CommerceState>,
    caller: Caller,
    Path(carrier_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const FAILED: &str = "Failed to update carrier credentials";
    let credentials = validate(&headers, &body, |issues, fields| {
        for key in ["apiKey", "apiSecret", "accountNumber"] {
            issues.text_with(fields, key, Presence::Optional, Text::default());
        }
        fields.clone()
    });
    let credentials = match credentials {
        Ok(credentials) => credentials,
        Err(refusal) => return refusal.respond(FAILED),
    };
    let exists: Result<Option<String>, sqlx::Error> =
        sqlx::query_scalar("select id from carriers where id = $1 and deleted_at is null limit 1")
            .bind(&carrier_id)
            .fetch_optional(&caller.db)
            .await;
    match exists {
        Ok(Some(_)) => {}
        Ok(None) => return Refusal::not_found("Carrier", &carrier_id).respond(FAILED),
        Err(error) => return Refusal::Database(error).respond(FAILED),
    }
    let written = sqlx::query(
        "update carriers set api_credentials = $1, updated_at = $2::timestamp \
         where id = $3 and deleted_at is null",
    )
    .bind(Value::Object(credentials))
    .bind(now())
    .bind(&carrier_id)
    .execute(&caller.db)
    .await;
    if let Err(error) = written {
        return Refusal::Database(error).respond(FAILED);
    }
    caller.publish(
        &state,
        ev::PARCEL_SETTINGS_UPDATED,
        &carrier_id,
        &json!({ "carrierId": carrier_id, "credentialsUpdated": true }),
    );
    Data(json!({ "message": "Carrier credentials updated successfully" })).into_response()
}
