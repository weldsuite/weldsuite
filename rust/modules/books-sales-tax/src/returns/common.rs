//! What the sales tax returns, the calendar, the reports and the nexus
//! monitor share (`services/sales-tax-returns/{common,context}.ts`): return
//! statuses, money in cents, the request's clock, the refusals
//! (`TaxReturnError`) and loading the entity, agencies and returns.

use axum::Json;
use axum::response::IntoResponse;
use http::StatusCode;
use serde_json::{Map, Value, json};
use weldsuite_books_domain::entity_context::resolve_entity_id;
use weldsuite_books_domain::http::{BooksState, Caller, Refusal};
use weldsuite_books_domain::js::iso_from_millis;
use weldsuite_books_domain::sales_tax::{from_cents, to_cents};
use weldsuite_books_domain::tables::{ENTITIES, SALES_TAX_AGENCIES, TAX_RETURNS};
use weldsuite_books_domain::tax_calendar::AgencyInput;
use weldsuite_db::PgPool;

use crate::common::{now_of, text};

/// `FILED_STATUSES`.
pub(crate) const FILED_STATUSES: [&str; 2] = ["filed", "paid"];
/// `EDITABLE_STATUSES`.
pub(crate) const EDITABLE_STATUSES: [&str; 3] = ["open", "calculated", "reviewed"];
/// `ADJUSTMENT_TYPES`.
pub(crate) const ADJUSTMENT_TYPES: [&str; 6] = [
    "vendor_discount",
    "prepayment",
    "penalty",
    "interest",
    "rounding",
    "other",
];

pub(crate) fn is_filed(ret: &Value) -> bool {
    FILED_STATUSES.contains(&text(ret, "status").unwrap_or(""))
}

pub(crate) fn is_editable(ret: &Value) -> bool {
    EDITABLE_STATUSES.contains(&text(ret, "status").unwrap_or(""))
}

/// `row[key]`, or `""`.
pub(crate) fn s<'a>(row: &'a Value, key: &str) -> &'a str {
    text(row, key).unwrap_or("")
}

/// `row[key]` as a JSON string or `null`.
pub(crate) fn opt(row: &Value, key: &str) -> Value {
    text(row, key).map_or(Value::Null, |t| json!(t))
}

// ── Refusals (`TaxReturnError`) ─────────────────────────────────────────────

/// `TaxReturnError(message)`: a 400.
pub(crate) fn bad(message: impl Into<String>) -> Refusal {
    Refusal::bad_request(message)
}

/// `TaxReturnError(message, 'bad_request', details)`.
pub(crate) fn bad_with(message: impl Into<String>, details: Value) -> Refusal {
    Refusal::bad_request_with(message, details)
}

/// `TaxReturnError(message, 'not_found')`: `c.json({ error: { code:
/// 'NOT_FOUND', message } }, 404)`.
pub(crate) fn not_found(message: impl Into<String>) -> Refusal {
    Refusal::Response(Box::new(
        (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": { "code": "NOT_FOUND", "message": message.into() } })),
        )
            .into_response(),
    ))
}

/// `TaxReturnError(message, 'conflict')`.
pub(crate) fn conflict(message: impl Into<String>) -> Refusal {
    Refusal::conflict(message)
}

// ── Money and dates ─────────────────────────────────────────────────────────

/// `num(value)`: `Number(value)`, 0 for null, empty or not finite.
pub(crate) fn num(value: &Value) -> f64 {
    let n = match value {
        Value::Null => return 0.0,
        Value::String(t) if t.is_empty() => return 0.0,
        Value::Number(n) => n.as_f64().unwrap_or(0.0),
        other => weldsuite_books_domain::js::js_number_value(Some(other)),
    };
    if n.is_finite() { n } else { 0.0 }
}

/// `num(row[key])`.
pub(crate) fn num_at(row: &Value, key: &str) -> f64 {
    num(row.get(key).unwrap_or(&Value::Null))
}

/// `round2(value)`: whole cents, half away from zero.
pub(crate) fn round2(value: f64) -> f64 {
    from_cents(to_cents(value))
}

/// `sumMoney(values)`.
pub(crate) fn sum_money(values: impl IntoIterator<Item = f64>) -> f64 {
    from_cents(values.into_iter().map(to_cents).sum())
}

/// A JSON number as JavaScript writes it.
pub(crate) fn n(value: f64) -> Value {
    weldsuite_books_domain::js::number_value(value)
}

/// `nextDay(day)`.
pub(crate) fn next_day(day: &str) -> String {
    weldsuite_books_domain::dates::add_days(day, 1).unwrap_or_default()
}

/// `startOfDay(day)` as Drizzle binds it.
pub(crate) fn start_of_day(day: &str) -> String {
    format!("{day}T00:00:00.000Z")
}

/// `addDays` of `us-compliance/dates`.
pub(crate) fn add_days(day: &str, days: i64) -> String {
    weldsuite_books_domain::dates::add_days(day, days).unwrap_or_default()
}

/// `addMonths` of `us-compliance/dates`.
pub(crate) fn add_months(day: &str, months: i64) -> String {
    weldsuite_books_domain::dates::add_months(day, months).unwrap_or_default()
}

/// The request's `new Date()` as `toISOString()`.
pub(crate) fn now_iso(caller: &Caller, state: &BooksState) -> String {
    iso_from_millis(now_of(caller, state).as_millisecond()).unwrap_or_default()
}

/// `stateOfAddress(address)`: the upper-cased `state` of a stored address.
pub(crate) fn state_of_address(address: &Value) -> String {
    address
        .get("state")
        .and_then(Value::as_str)
        .map(|s| weldsuite_kit::validation::js_trim(s).to_uppercase())
        .unwrap_or_default()
}

/// `registeredOn(agencies, stateCode, date)`.
pub(crate) fn registered_on(agencies: &[Value], state_code: Option<&str>, date: &str) -> bool {
    let Some(code) = state_code.filter(|c| !c.is_empty()) else {
        return false;
    };
    let code = code.to_uppercase();
    agencies.iter().any(|a| {
        s(a, "stateCode").to_uppercase() == code
            && matches!(s(a, "status"), "registered" | "closed")
            && text(a, "registeredFrom")
                .filter(|f| !f.is_empty())
                .is_none_or(|f| f <= date)
            && text(a, "registeredUntil")
                .filter(|u| !u.is_empty())
                .is_none_or(|u| date <= u)
    })
}

/// `computeTotalDue(summary, adjustments)`.
pub(crate) fn compute_total_due(summary: &Value, adjustments: &[Value]) -> f64 {
    let mut values = vec![
        summary
            .get("salesTaxPayable")
            .filter(|v| !v.is_null())
            .map_or(0.0, num),
        summary
            .get("useTaxPayable")
            .filter(|v| !v.is_null())
            .map_or(0.0, num),
    ];
    values.extend(adjustments.iter().map(|a| num_at(a, "amount")));
    sum_money(values)
}

/// A return's `adjustments` (`ret.adjustments ?? []`).
pub(crate) fn adjustments_of(ret: &Value) -> Vec<Value> {
    ret["adjustments"].as_array().cloned().unwrap_or_default()
}

// ── Agencies ────────────────────────────────────────────────────────────────

/// `agencyToInput(agency)`: the agency as a calendar input (its periods).
pub(crate) fn agency_to_input(agency: &Value) -> AgencyInput {
    let frequency = text(agency, "filingFrequency").unwrap_or("");
    let due = agency["dueDay"].as_i64().filter(|d| *d != 0).unwrap_or(20);
    AgencyInput {
        id: text(agency, "id").unwrap_or_default().to_owned(),
        name: text(agency, "name").map(str::to_owned),
        state_code: text(agency, "stateCode").map(str::to_owned),
        filing_frequency: if ["monthly", "quarterly", "semiannual", "annual"].contains(&frequency) {
            frequency.to_owned()
        } else {
            "quarterly".to_owned()
        },
        due_day: Some(due.clamp(1, 31)),
        first_period_start: text(agency, "firstPeriodStart")
            .or_else(|| text(agency, "registeredFrom"))
            .map(str::to_owned),
        registered_until: text(agency, "registeredUntil").map(str::to_owned),
        status: Some("registered".to_owned()),
    }
}

/// `loadAgencies(db, entityId)`: the entity's live agencies by state and name.
pub(crate) async fn load_agencies(db: &PgPool, entity_id: &str) -> Result<Vec<Value>, sqlx::Error> {
    let rows: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(sales_tax_agencies),
        " from sales_tax_agencies t where t.entity_id = $1 and t.deleted_at is null \
         order by t.state_code, t.name"
    ))
    .bind(entity_id)
    .fetch_all(db)
    .await?;
    Ok(SALES_TAX_AGENCIES.js_rows(rows))
}

/// `loadAgency(db, entityId, agencyId)`.
pub(crate) async fn load_agency(
    db: &PgPool,
    entity_id: &str,
    agency_id: &str,
) -> Result<Value, Refusal> {
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(sales_tax_agencies),
        " from sales_tax_agencies t where t.id = $1 and t.entity_id = $2 and t.deleted_at is null limit 1"
    ))
    .bind(agency_id)
    .bind(entity_id)
    .fetch_optional(db)
    .await?;
    row.map(|r| SALES_TAX_AGENCIES.js(r))
        .ok_or_else(|| not_found(format!("Sales tax agency {agency_id} not found")))
}

// ── Entities and returns ────────────────────────────────────────────────────

/// `resolveEntityId(c, db)`, or `TaxReturnError('No accounting entity
/// resolved')`.
pub(crate) async fn entity_id_of(caller: &Caller) -> Result<String, Refusal> {
    resolve_entity_id(caller)
        .await?
        .ok_or_else(|| bad("No accounting entity resolved"))
}

/// `loadUsEntity(db, entityId)`.
pub(crate) async fn load_us_entity(db: &PgPool, entity_id: &str) -> Result<Value, Refusal> {
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(entities),
        " from entities t where t.id = $1 and t.deleted_at is null limit 1"
    ))
    .bind(entity_id)
    .fetch_optional(db)
    .await?;
    let Some(entity) = row.map(|r| ENTITIES.js(r)) else {
        return Err(not_found(format!(
            "Accounting entity {entity_id} not found"
        )));
    };
    if text(&entity, "jurisdictionCode") != Some("US") {
        return Err(bad(
            "Sales tax returns are only available for US accounting entities",
        ));
    }
    Ok(entity)
}

/// The request's US entity (`entityOf(c)` of the report routes).
pub(crate) async fn us_entity_of(caller: &Caller) -> Result<Value, Refusal> {
    let id = entity_id_of(caller).await?;
    load_us_entity(&caller.db, &id).await
}

/// A `tax_returns` row by id, as Drizzle returns it.
pub(crate) async fn return_by_id(db: &PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(tax_returns),
        " from tax_returns t where t.id = $1 limit 1"
    ))
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(|r| TAX_RETURNS.js(r)))
}

/// `loadReturn(db, entityId, id)`.
pub(crate) async fn load_return(db: &PgPool, entity_id: &str, id: &str) -> Result<Value, Refusal> {
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(tax_returns),
        " from tax_returns t where t.id = $1 and t.entity_id = $2 and t.deleted_at is null limit 1"
    ))
    .bind(id)
    .bind(entity_id)
    .fetch_optional(db)
    .await?;
    row.map(|r| TAX_RETURNS.js(r))
        .ok_or_else(|| not_found(format!("Tax return {id} not found")))
}

/// `loadAgencyReturns(db, entityId, agencyId)`: newest period first.
pub(crate) async fn load_agency_returns(
    db: &PgPool,
    entity_id: &str,
    agency_id: &str,
) -> Result<Vec<Value>, sqlx::Error> {
    let rows: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(tax_returns),
        " from tax_returns t where t.entity_id = $1 and t.agency_id = $2 and t.deleted_at is null \
         order by t.period_end desc, t.created_at desc"
    ))
    .bind(entity_id)
    .bind(agency_id)
    .fetch_all(db)
    .await?;
    Ok(TAX_RETURNS.js_rows(rows))
}

/// `ReturnContext`: the entity, the return and its agency.
pub(crate) struct ReturnContext {
    pub entity: Value,
    pub ret: Value,
    pub agency: Value,
}

/// `loadReturnContext(db, entityId, id)` after `resolveEntityId`.
pub(crate) async fn return_context(caller: &Caller, id: &str) -> Result<ReturnContext, Refusal> {
    let entity_id = entity_id_of(caller).await?;
    let db = &caller.db;
    let entity = load_us_entity(db, &entity_id).await?;
    let ret = load_return(db, &entity_id, id).await?;
    let Some(agency_id) = text(&ret, "agencyId").filter(|a| !a.is_empty()) else {
        return Err(bad("This tax return has no agency"));
    };
    let agency = load_agency(db, &entity_id, agency_id).await?;
    Ok(ReturnContext {
        entity,
        ret,
        agency,
    })
}

/// `serialize(ret)`: the money as numbers.
pub(crate) fn serialize(ret: &Value) -> Value {
    let mut out = ret.as_object().cloned().unwrap_or_default();
    out.insert("totalDue".into(), n(num_at(ret, "totalDue")));
    out.insert(
        "paymentAmount".into(),
        if ret["paymentAmount"].is_null() {
            Value::Null
        } else {
            n(num_at(ret, "paymentAmount"))
        },
    );
    Value::Object(out)
}

/// `serialize(ret)` with more fields.
pub(crate) fn serialize_with(ret: &Value, extra: Map<String, Value>) -> Value {
    let mut out = serialize(ret);
    if let Value::Object(map) = &mut out {
        map.extend(extra);
    }
    out
}

/// `reportingBasisOf(agency)`.
pub(crate) fn reporting_basis_of(agency: &Value) -> &'static str {
    if text(agency, "reportingBasis") == Some("cash") {
        "cash"
    } else {
        "accrual"
    }
}
