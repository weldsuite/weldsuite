//! `/api/parcel-wallet`: one wallet per user (`wallets`), lazily created on
//! the first read, with credit and debit transactions
//! (`wallet_transactions`). Balances use JavaScript's float arithmetic, as
//! the route does: the response says `10.799999999999999` where the column
//! stores `10.80`.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{RawQuery, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_catalogs::entity_events as ev;
use weldsuite_catalogs::permission_keys as perm;
use weldsuite_kit::validation::{Issues, Number, Presence, Text};
use weldsuite_kit::{ApiError, Created, Data, generate_id};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::js::{js_date_iso, number_text, number_value, numeric};
use crate::table::WriteError;
use crate::tables;
use crate::{Caller, CommerceState, Refusal, now, positive, validate, validate_query};

pub(crate) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<CommerceState>
where
    Q: PermissionQueries + 'static,
{
    let read = || gate.require([perm::CARRIERS_READ]);
    let manage = || gate.require([perm::CARRIERS_MANAGE]);
    Router::new()
        .route("/", get(wallet).route_layer(read()))
        .route("/with-transactions", get(with_transactions).route_layer(read()))
        .route("/transactions", get(transactions).route_layer(read()))
        .route("/credits", post(credits).route_layer(manage()))
        .route("/deduct", post(deduct).route_layer(manage()))
        .route("/check-balance", post(check_balance).route_layer(read()))
        .route("/estimate-cost", post(estimate_cost).route_layer(read()))
}

/// The failures of a route body: a refusal, or a write Drizzle refused.
enum Failure {
    Refusal(Refusal),
    Write(WriteError),
}

impl From<sqlx::Error> for Failure {
    fn from(error: sqlx::Error) -> Self {
        Self::Refusal(Refusal::Database(error))
    }
}

impl From<WriteError> for Failure {
    fn from(error: WriteError) -> Self {
        Self::Write(error)
    }
}

impl Failure {
    fn respond(self, message: &str) -> Response {
        match self {
            Self::Refusal(refusal) => refusal.respond(message),
            Self::Write(error) => {
                tracing::error!(%error, "[commerce-api/parcel-wallet] {message}");
                ApiError::internal().with_message(message).into_response()
            }
        }
    }
}

/// `Number(x) || 0`.
fn amount_of(value: Option<&Value>) -> f64 {
    let n = value.map_or(0.0, numeric);
    if n.is_nan() { 0.0 } else { n }
}

/// `x ? Number(x) : undefined` for a numeric column.
fn optional_amount(value: Option<&Value>) -> Option<Value> {
    match value {
        Some(Value::String(text)) if !text.is_empty() => Some(number_value(numeric(&Value::String(text.clone())))),
        _ => None,
    }
}

async fn live_wallet(caller: &Caller, user_id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        row_of!(wallets),
        " from wallets t where t.user_id = $1 and t.deleted_at is null limit 1"
    ))
    .bind(user_id)
    .fetch_optional(&caller.db)
    .await?;
    Ok(row.map(|row| tables::WALLETS.js(row)))
}

/// Insert a wallet with `extra` columns set, and read it back.
async fn new_wallet(caller: &Caller, user_id: &str, full: bool) -> Result<Value, Failure> {
    let id = generate_id("wal");
    let now = now();
    let t = &tables::WALLETS;
    let mut values = Map::new();
    t.set(&mut values, "id", json!(id));
    t.set(&mut values, "userId", json!(user_id));
    t.set(&mut values, "balance", json!("0"));
    t.set(&mut values, "currency", json!("EUR"));
    t.set(&mut values, "isActive", json!(true));
    if full {
        t.set(&mut values, "isFrozen", json!(false));
        t.set(&mut values, "totalCredits", json!("0"));
        t.set(&mut values, "totalDebits", json!("0"));
        t.set(&mut values, "transactionCount", json!(0));
    }
    t.set(&mut values, "createdAt", json!(now));
    t.set(&mut values, "updatedAt", json!(now));
    Ok(t.insert(&caller.db, values, &["createdAt", "updatedAt"]).await?)
}

fn user_query(query: Option<&str>) -> Result<Option<String>, Refusal> {
    validate_query(query, |issues, fields| {
        issues
            .text_with(fields, "userId", Presence::Optional, Text::default())
            .into_option()
    })
}

fn currency(row: &Value) -> Value {
    match row.get("currency") {
        Some(Value::String(c)) if !c.is_empty() => json!(c),
        _ => json!("EUR"),
    }
}

fn or_default(row: &Value, key: &str, fallback: Value) -> Value {
    row.get(key).filter(|v| !v.is_null()).cloned().unwrap_or(fallback)
}

fn count_of(row: &Value) -> Value {
    match row.get("transactionCount") {
        Some(Value::Number(n)) if n.as_f64().is_some_and(|n| n != 0.0) => Value::Number(n.clone()),
        _ => json!(0),
    }
}

async fn wallet(State(state): State<CommerceState>, caller: Caller, RawQuery(query): RawQuery) -> Response {
    const FAILED: &str = "Failed to get wallet";
    let target = match user_query(query.as_deref()) {
        Ok(user) => user.unwrap_or_else(|| caller.user_id.clone()),
        Err(refusal) => return refusal.respond(FAILED),
    };
    let wallet = match live_wallet(&caller, &target).await {
        Ok(Some(wallet)) => wallet,
        Ok(None) => match new_wallet(&caller, &target, true).await {
            Ok(wallet) => {
                let id = wallet["id"].as_str().unwrap_or_default().to_owned();
                caller.publish(
                    &state,
                    ev::PARCEL_WALLET_CREATED,
                    &id,
                    &json!({ "id": id, "userId": target }),
                );
                wallet
            }
            Err(failure) => return failure.respond(FAILED),
        },
        Err(error) => return Refusal::Database(error).respond(FAILED),
    };
    let mut out = Map::new();
    out.insert("id".to_owned(), wallet["id"].clone());
    out.insert(
        "balance".to_owned(),
        json!({ "amount": number_value(amount_of(wallet.get("balance"))), "currency": currency(&wallet) }),
    );
    for key in ["creditLimit", "lowBalanceThreshold"] {
        if let Some(value) = optional_amount(wallet.get(key)) {
            out.insert(key.to_owned(), value);
        }
    }
    out.insert("isActive".to_owned(), or_default(&wallet, "isActive", json!(true)));
    out.insert("isFrozen".to_owned(), or_default(&wallet, "isFrozen", json!(false)));
    out.insert("totalCredits".to_owned(), number_value(amount_of(wallet.get("totalCredits"))));
    out.insert("totalDebits".to_owned(), number_value(amount_of(wallet.get("totalDebits"))));
    out.insert("transactionCount".to_owned(), count_of(&wallet));
    if let Some(at) = wallet.get("lastTransactionAt").filter(|v| !v.is_null()) {
        out.insert("lastTransactionAt".to_owned(), at.clone());
    }
    out.insert("createdAt".to_owned(), wallet["createdAt"].clone());
    Data(Value::Object(out)).into_response()
}

/// A transaction row as the routes answer it; `nested` puts the amount in
/// `{ amount, currency }` (`/with-transactions`).
fn transaction(row: &Value, nested: bool) -> Value {
    let mut out = Map::new();
    out.insert("id".to_owned(), row["id"].clone());
    out.insert("type".to_owned(), row["type"].clone());
    let amount = number_value(amount_of(row.get("amount")));
    if nested {
        out.insert("amount".to_owned(), json!({ "amount": amount, "currency": currency(row) }));
    } else {
        out.insert("amount".to_owned(), amount);
        out.insert("currency".to_owned(), currency(row));
    }
    for key in ["balanceBefore", "balanceAfter"] {
        if let Some(value) = optional_amount(row.get(key)) {
            out.insert(key.to_owned(), value);
        }
    }
    for key in ["referenceType", "referenceId", "description"] {
        if let Some(value) = row.get(key).filter(|v| !v.is_null()) {
            out.insert(key.to_owned(), value.clone());
        }
    }
    out.insert("createdAt".to_owned(), row["createdAt"].clone());
    Value::Object(out)
}

async fn with_transactions(
    State(_state): State<CommerceState>,
    caller: Caller,
    RawQuery(query): RawQuery,
) -> Response {
    const FAILED: &str = "Failed to get wallet data";
    let target = match user_query(query.as_deref()) {
        Ok(user) => user.unwrap_or_else(|| caller.user_id.clone()),
        Err(refusal) => return refusal.respond(FAILED),
    };
    let wallet = match live_wallet(&caller, &target).await {
        Ok(Some(wallet)) => wallet,
        Ok(None) => return Data(json!({ "wallet": null, "transactions": [] })).into_response(),
        Err(error) => return Refusal::Database(error).respond(FAILED),
    };
    let rows: Result<Vec<Value>, sqlx::Error> = sqlx::query_scalar(concat!(
        "select ",
        row_of!(wallet_transactions),
        " from wallet_transactions t where t.wallet_id = $1 order by t.created_at desc limit 50"
    ))
    .bind(wallet["id"].as_str())
    .fetch_all(&caller.db)
    .await;
    let rows = match rows {
        Ok(rows) => rows,
        Err(error) => return Refusal::Database(error).respond(FAILED),
    };
    let transactions: Vec<Value> = rows
        .into_iter()
        .map(|row| transaction(&tables::WALLET_TRANSACTIONS.js(row), true))
        .collect();
    Data(json!({
        "wallet": {
            "id": wallet["id"],
            "balance": { "amount": number_value(amount_of(wallet.get("balance"))), "currency": currency(&wallet) },
            "isActive": or_default(&wallet, "isActive", json!(true)),
            "isFrozen": or_default(&wallet, "isFrozen", json!(false)),
            "totalCredits": number_value(amount_of(wallet.get("totalCredits"))),
            "totalDebits": number_value(amount_of(wallet.get("totalDebits"))),
            "transactionCount": count_of(&wallet),
        },
        "transactions": transactions,
    }))
    .into_response()
}

struct Page {
    page: f64,
    page_size: f64,
    kind: Option<String>,
    from: Option<String>,
    to: Option<String>,
}

fn read_page(issues: &mut Issues, fields: &Map<String, Value>) -> Page {
    let coerce = |min: Option<f64>, max: Option<f64>| Number {
        coerce: true,
        min,
        max,
        ..Number::default()
    };
    let page = issues
        .number(fields, "page", Presence::Optional, coerce(Some(1.0), None))
        .into_option()
        .unwrap_or(1.0);
    let page_size = issues
        .number(fields, "pageSize", Presence::Optional, coerce(Some(1.0), Some(100.0)))
        .into_option()
        .unwrap_or(20.0);
    let mut text = |key: &str| {
        issues
            .text_with(fields, key, Presence::Optional, Text::default())
            .into_option()
    };
    Page {
        page,
        page_size,
        kind: text("type"),
        from: text("dateFrom"),
        to: text("dateTo"),
    }
}

async fn transactions(State(_state): State<CommerceState>, caller: Caller, RawQuery(query): RawQuery) -> Response {
    const FAILED: &str = "Failed to get transactions";
    let page = match validate_query(query.as_deref(), read_page) {
        Ok(page) => page,
        Err(refusal) => return refusal.respond(FAILED),
    };
    match list_transactions(&caller, &page).await {
        Ok(response) => response,
        Err(refusal) => refusal.respond(FAILED),
    }
}

async fn list_transactions(caller: &Caller, page: &Page) -> Result<Response, Refusal> {
    let Some(wallet) = live_wallet(caller, &caller.user_id).await? else {
        return Ok(Data(json!({
            "transactions": [],
            "pagination": { "page": 1, "pageSize": number_value(page.page_size), "totalCount": 0, "totalPages": 0, "hasMore": false },
        }))
        .into_response());
    };
    // `if (type)`, `if (dateFrom)`: empty values are no filter; an Invalid
    // Date makes Drizzle throw.
    let kind = page.kind.as_deref().filter(|k| !k.is_empty());
    let date = |text: Option<&str>| -> Result<Option<String>, Refusal> {
        match text.filter(|t| !t.is_empty()) {
            None => Ok(None),
            Some(text) => js_date_iso(text)
                .map(Some)
                .ok_or_else(|| Refusal::Response(Box::new(ApiError::internal().with_message("Failed to get transactions").into_response()))),
        }
    };
    let from = date(page.from.as_deref())?;
    let to = date(page.to.as_deref())?;
    let wallet_id = wallet["id"].as_str().unwrap_or_default();
    let total: i32 = sqlx::query_scalar(
        "select count(*)::int from wallet_transactions where wallet_id = $1 \
         and ($2::text is null or type = $2) \
         and ($3::text is null or created_at >= $3::timestamp) \
         and ($4::text is null or created_at <= $4::timestamp)",
    )
    .bind(wallet_id)
    .bind(kind)
    .bind(from.as_deref())
    .bind(to.as_deref())
    .fetch_one(&caller.db)
    .await?;
    let total_pages = (f64::from(total) / page.page_size).ceil();
    let offset = (page.page - 1.0) * page.page_size;
    // `.offset(x)` is left out when x is falsy.
    let offset = (offset != 0.0 && !offset.is_nan()).then(|| number_text(offset));
    let rows: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        row_of!(wallet_transactions),
        " from wallet_transactions t where t.wallet_id = $1 \
         and ($2::text is null or t.type = $2) \
         and ($3::text is null or t.created_at >= $3::timestamp) \
         and ($4::text is null or t.created_at <= $4::timestamp) \
         order by t.created_at desc limit $5::text::bigint offset coalesce($6::text::bigint, 0)"
    ))
    .bind(wallet_id)
    .bind(kind)
    .bind(from.as_deref())
    .bind(to.as_deref())
    .bind(number_text(page.page_size))
    .bind(offset)
    .fetch_all(&caller.db)
    .await?;
    let transactions: Vec<Value> = rows
        .into_iter()
        .map(|row| transaction(&tables::WALLET_TRANSACTIONS.js(row), false))
        .collect();
    Ok(Data(json!({
        "transactions": transactions,
        "pagination": {
            "page": number_value(page.page),
            "pageSize": number_value(page.page_size),
            "totalCount": total,
            "totalPages": number_value(total_pages),
            "hasMore": page.page < total_pages,
        },
    }))
    .into_response())
}

/// `addCreditsSchema` / `deductCreditsSchema`.
struct Movement {
    amount: f64,
    payment_method: Option<String>,
    payment_reference: Option<String>,
    reference_type: Option<String>,
    reference_id: Option<Value>,
    description: Option<String>,
}

fn read_credit(issues: &mut Issues, fields: &Map<String, Value>) -> Movement {
    let amount = positive(issues, fields, "amount", Presence::Required, false).unwrap_or(0.0);
    let mut text = |key: &str| {
        issues
            .text_with(fields, key, Presence::Optional, Text::default())
            .into_option()
    };
    Movement {
        amount,
        payment_method: text("paymentMethod"),
        payment_reference: text("paymentReference"),
        reference_type: None,
        reference_id: None,
        description: text("description"),
    }
}

fn read_debit(issues: &mut Issues, fields: &Map<String, Value>) -> Movement {
    let amount = positive(issues, fields, "amount", Presence::Required, false).unwrap_or(0.0);
    let reference_type = issues
        .text_with(fields, "referenceType", Presence::Optional, Text::default())
        .into_option();
    let reference_id = match issues.text_with(fields, "referenceId", Presence::Nullish, Text::default()) {
        weldsuite_kit::validation::Field::Set(id) => Some(json!(id)),
        weldsuite_kit::validation::Field::Null => Some(Value::Null),
        weldsuite_kit::validation::Field::Absent => None,
    };
    let description = issues
        .text_with(fields, "description", Presence::Optional, Text::default())
        .into_option();
    Movement {
        amount,
        payment_method: None,
        payment_reference: None,
        reference_type,
        reference_id,
        description,
    }
}

async fn credits(
    State(state): State<CommerceState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const FAILED: &str = "Failed to add credits";
    let movement = match validate(&headers, &body, read_credit) {
        Ok(movement) => movement,
        Err(refusal) => return refusal.respond(FAILED),
    };
    match apply(&state, &caller, &movement, true).await {
        Ok(response) => response,
        Err(failure) => failure.respond(FAILED),
    }
}

async fn deduct(
    State(state): State<CommerceState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const FAILED: &str = "Failed to deduct credits";
    let movement = match validate(&headers, &body, read_debit) {
        Ok(movement) => movement,
        Err(refusal) => return refusal.respond(FAILED),
    };
    match apply(&state, &caller, &movement, false).await {
        Ok(response) => response,
        Err(failure) => failure.respond(FAILED),
    }
}

/// A credit (`/credits`, creating a missing wallet) or a debit (`/deduct`).
async fn apply(
    state: &CommerceState,
    caller: &Caller,
    movement: &Movement,
    credit: bool,
) -> Result<Response, Failure> {
    let wallet = match live_wallet(caller, &caller.user_id).await? {
        Some(wallet) => wallet,
        None if credit => new_wallet(caller, &caller.user_id, false).await?,
        None => {
            return Err(Failure::Refusal(Refusal::bad_request("No wallet found for user")));
        }
    };
    let amount = movement.amount;
    let current = amount_of(wallet.get("balance"));
    if !credit && current < amount {
        return Err(Failure::Refusal(Refusal::bad_request(format!(
            "Insufficient balance: have {}, need {}",
            number_text(current),
            number_text(amount)
        ))));
    }
    let balance = if credit { current + amount } else { current - amount };
    let transaction_id = generate_id("wtx");
    let wallet_id = wallet["id"].as_str().unwrap_or_default().to_owned();
    let t = &tables::WALLET_TRANSACTIONS;
    let mut values = Map::new();
    t.set(&mut values, "id", json!(transaction_id));
    t.set(&mut values, "walletId", json!(wallet_id));
    t.set(&mut values, "userId", json!(caller.user_id));
    t.set(&mut values, "type", json!(if credit { "credit" } else { "debit" }));
    t.set(&mut values, "amount", json!(number_text(amount)));
    t.set(&mut values, "currency", currency(&wallet));
    t.set(&mut values, "balanceBefore", json!(number_text(current)));
    t.set(&mut values, "balanceAfter", json!(number_text(balance)));
    if let Some(kind) = &movement.reference_type {
        t.set(&mut values, "referenceType", json!(kind));
    }
    if let Some(id) = &movement.reference_id {
        t.set(&mut values, "referenceId", id.clone());
    }
    let description = movement.description.clone().unwrap_or_else(|| {
        if credit {
            format!(
                "Added {} credits via {}",
                number_text(amount),
                movement.payment_method.as_deref().unwrap_or("deposit")
            )
        } else {
            format!("Charge of {}", number_text(amount))
        }
    });
    t.set(&mut values, "description", json!(description));
    if let Some(reference) = movement.payment_reference.as_deref().filter(|r| !r.is_empty()) {
        t.set(&mut values, "metadata", json!({ "paymentReference": reference }));
    }
    t.insert(&caller.db, values, &[]).await?;
    let now = now();
    let statement = if credit {
        "update wallets set balance = $1::numeric, total_credits = total_credits + $2::numeric, \
         transaction_count = transaction_count + 1, last_transaction_at = $3::timestamp, \
         updated_at = $3::timestamp where id = $4"
    } else {
        "update wallets set balance = $1::numeric, total_debits = total_debits + $2::numeric, \
         transaction_count = transaction_count + 1, last_transaction_at = $3::timestamp, \
         updated_at = $3::timestamp where id = $4"
    };
    sqlx::query(statement)
        .bind(number_text(balance))
        .bind(number_text(amount))
        .bind(&now)
        .bind(&wallet_id)
        .execute(&caller.db)
        .await?;
    let signed = if credit { amount } else { -amount };
    caller.publish(
        state,
        ev::PARCEL_WALLET_UPDATED,
        &wallet_id,
        &json!({
            "id": wallet_id,
            "userId": caller.user_id,
            "transactionId": transaction_id,
            "amount": number_value(signed),
            "newBalance": number_value(balance),
        }),
    );
    Ok(Created(json!({ "newBalance": number_value(balance), "transactionId": transaction_id })).into_response())
}

async fn check_balance(
    State(_state): State<CommerceState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const FAILED: &str = "Failed to check balance";
    let amount = match validate(&headers, &body, |issues, fields| {
        positive(issues, fields, "amount", Presence::Required, false).unwrap_or(0.0)
    }) {
        Ok(amount) => amount,
        Err(refusal) => return refusal.respond(FAILED),
    };
    let balance = match live_wallet(&caller, &caller.user_id).await {
        Ok(wallet) => wallet.map_or(0.0, |w| amount_of(w.get("balance"))),
        Err(error) => return Refusal::Database(error).respond(FAILED),
    };
    Data(json!({
        "hasSufficientBalance": balance >= amount,
        "currentBalance": number_value(balance),
        "required": number_value(amount),
        "shortfall": number_value((amount - balance).max(0.0)),
    }))
    .into_response()
}

async fn estimate_cost(
    State(_state): State<CommerceState>,
    caller: Caller,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    const FAILED: &str = "Failed to estimate cost";
    let read = validate(&headers, &body, |issues, fields| {
        let mut text = |key: &str, presence: Presence| {
            issues
                .text_with(fields, key, presence, Text::default())
                .into_option()
        };
        let carrier = text("carrierId", Presence::Required);
        let from = text("fromCountry", Presence::Required);
        let to = text("toCountry", Presence::Required);
        let weight = positive(issues, fields, "weight", Presence::Required, true);
        let service = issues
            .text_with(fields, "serviceType", Presence::Optional, Text::default())
            .into_option();
        (
            carrier.unwrap_or_default(),
            from.unwrap_or_default(),
            to.unwrap_or_default(),
            weight.unwrap_or(0.0),
            service,
        )
    });
    let (carrier, from, to, weight, service) = match read {
        Ok(read) => read,
        Err(refusal) => return refusal.respond(FAILED),
    };
    let rows: Result<Vec<Value>, sqlx::Error> = sqlx::query_scalar(concat!(
        "select ",
        row_of!(shipping_prices),
        " from shipping_prices t where t.carrier_id = $1 and t.is_active = true \
         and t.deleted_at is null limit 10"
    ))
    .bind(&carrier)
    .fetch_all(&caller.db)
    .await;
    let rows = match rows {
        Ok(rows) => rows,
        Err(error) => return Refusal::Database(error).respond(FAILED),
    };
    if let Some(row) = rows.into_iter().next() {
        let price = tables::SHIPPING_PRICES.js(row);
        let flat = price.get("flatRate").filter(|f| !f.is_null());
        let base = flat
            .and_then(|f| f.get("amount"))
            .filter(|a| !a.is_null())
            .cloned()
            .unwrap_or_else(|| json!(0));
        let currency = flat
            .and_then(|f| f.get("currency"))
            .filter(|c| !c.is_null())
            .cloned()
            .or_else(|| price.get("currency").filter(|c| !c.is_null()).cloned())
            .unwrap_or_else(|| json!("EUR"));
        return Data(json!({
            "estimatedCost": base,
            "currency": currency,
            "breakdown": { "basePrice": base, "weightCharge": 0 },
        }))
        .into_response();
    }
    let mut rate = if from == to { 10.0 } else { 25.0 };
    rate += weight * 2.0;
    match service.as_deref() {
        Some("EXPRESS") => rate *= 1.5,
        Some("OVERNIGHT") => rate *= 2.0,
        _ => {}
    }
    Data(json!({
        "estimatedCost": number_value(rate),
        "currency": "EUR",
        "breakdown": { "basePrice": number_value(rate), "weightCharge": 0 },
    }))
    .into_response()
}
