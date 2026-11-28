//! `/api/accounting-quotes` and `POST /api/invoices/from-quote/:quoteId`
//! (Rust only, edition feature `books-quotes`; ADR BOOKS-012).
//!
//! WeldCRM's `crm_quotes` is the one quote record; WeldBooks lists it, writes
//! it the way the CRM's own API does (a thin create and update here, because
//! the CRM only exposes quotes through API keys), e-mails it, and turns it
//! into invoices. A quote belongs to no legal entity (`crm_quotes` has no
//! `entity_id`): the entity is chosen when it is invoiced.
//!
//! A WeldBooks contact is a party. A quote written here keeps the party in
//! `customer_id` (and the party's company or person in `counterparty_id` /
//! `person_id`); a CRM quote is matched on those CRM ids.
//!
//! Permissions: `invoices:read`, `invoices:create`, `invoices:update` (WeldBooks'
//! own: the CRM's `quotes:*` keys guard only its API-key routes, and an
//! accountant with WeldBooks access has no WeldCRM role).
//!
//! The totals of a quote written here are the plain sum of its lines with
//! each line's own rate (the CRM keeps no tax engine); the invoice made from
//! it is calculated by the real one.

use std::collections::{HashMap, HashSet};
use std::str::FromStr;
use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::Response;
use axum::routing::{delete, get, post};
use http::HeaderMap;
use sea_orm::prelude::BigDecimal;
use sea_orm::sea_query::{Expr, Query};
use sea_orm::{
    ActiveValue::{NotSet, Set},
    ColumnTrait, Condition, DbErr, EntityTrait, PaginatorTrait, QueryFilter, QueryOrder,
    QuerySelect,
};
use serde_json::{Map, Value, json};
use weldsuite_books_domain::entity_context::resolve_requested_entity_id;
use weldsuite_books_domain::http::{
    BooksState, Caller, Refusal, Reply, created, json_of, ok, paged, reply,
};
use weldsuite_books_domain::js::parse_int;
use weldsuite_books_domain::reminders::{cents_text, parse_cents};
use weldsuite_catalogs::entity_events::{QUOTE_CREATED, QUOTE_UPDATED};
use weldsuite_db::{PgPool, orm, utc_now};
use weldsuite_kit::generate_id;
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::{crm_quotes, invoices, parties};

use crate::body::{InvoiceInput, LineInput};
use crate::delivery::email;
use crate::delivery::public::load_quote;
use crate::delivery::view::{decimal, plain, quote_party, quote_party_id, quote_status};
use crate::errors::SalesError;
use crate::invoices::{js_timestamp, page_window, row_json};
use crate::persist::{owned, text};

pub(crate) fn router<S, Q>(state: BooksState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route("/", get(list).route_layer(need("invoices:read")))
        .route("/", post(create).route_layer(need("invoices:create")))
        .route("/{id}", get(detail).route_layer(need("invoices:read")))
        .route(
            "/{id}",
            axum::routing::put(update)
                .patch(update)
                .route_layer(need("invoices:update")),
        )
        .route(
            "/{id}/email",
            post(email::quote).route_layer(need("invoices:update")),
        )
        .route(
            "/{id}/public-link",
            delete(email::revoke_quote_link).route_layer(need("invoices:update")),
        )
        .with_state(state)
}

// ── Lines and totals ────────────────────────────────────────────────────────

fn number(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

#[allow(clippy::cast_possible_truncation)]
fn to_cents(amount: f64) -> i64 {
    (amount * 100.0).round() as i64
}

/// A line as it is stored, and its amounts in cents.
#[derive(Debug, PartialEq)]
pub(crate) struct Priced {
    pub line: Value,
    pub total: i64,
    pub discount: i64,
    pub tax: i64,
}

/// Check one body line and price it: `{ description, quantity, unitPrice,
/// discountPercent, taxRate, lineTotal, ... }` with decimals as text.
pub(crate) fn price_line(raw: &Value, index: usize) -> Result<Priced, Refusal> {
    let bad = |what: &str| Refusal::bad_request(format!("lines[{index}].{what}"));
    let fields = raw.as_object().ok_or_else(|| bad("must be an object"))?;
    let description = fields
        .get("description")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|d| !d.is_empty() && d.chars().count() <= 500)
        .ok_or_else(|| bad("description is required (at most 500 characters)"))?;
    let quantity = match fields.get("quantity").filter(|v| !v.is_null()) {
        None => 1.0,
        Some(v) => number(Some(v))
            .filter(|q| *q > 0.0 && q.is_finite())
            .ok_or_else(|| bad("quantity must be a positive number"))?,
    };
    let price = number(fields.get("unitPrice"))
        .filter(|p| p.is_finite())
        .ok_or_else(|| bad("unitPrice must be a number"))?;
    let discount = match fields.get("discountPercent").filter(|v| !v.is_null()) {
        None => 0.0,
        Some(v) => number(Some(v))
            .filter(|d| (0.0..=100.0).contains(d))
            .ok_or_else(|| bad("discountPercent must be from 0 to 100"))?,
    };
    let rate = match fields.get("taxRate").filter(|v| !v.is_null()) {
        None => 0.0,
        Some(v) => number(Some(v))
            .filter(|r| (0.0..=100.0).contains(r))
            .ok_or_else(|| bad("taxRate must be from 0 to 100"))?,
    };
    let gross = to_cents(quantity * price);
    let total = to_cents(quantity * price * (1.0 - discount / 100.0));
    #[allow(clippy::cast_possible_truncation, clippy::cast_precision_loss)]
    let tax = (total as f64 * rate / 100.0).round() as i64;
    let mut line = Map::new();
    line.insert("description".into(), json!(description));
    line.insert("quantity".into(), json!(plain(quantity)));
    line.insert("unitPrice".into(), json!(plain(price)));
    line.insert("discountPercent".into(), json!(plain(discount)));
    line.insert("taxRate".into(), json!(plain(rate)));
    line.insert("lineTotal".into(), json!(cents_text(total)));
    for key in ["unit", "taxRateId", "accountId", "productId"] {
        if let Some(Value::String(s)) = fields.get(key).filter(|v| !v.is_null()) {
            if s.chars().count() > 64 {
                return Err(bad(&format!("{key} is too long")));
            }
            line.insert(key.into(), json!(s));
        }
    }
    Ok(Priced {
        line: Value::Object(line),
        total,
        discount: gross - total,
        tax,
    })
}

/// The lines of a body and their sums: `(lines, subtotal, discount, tax)` in cents.
pub(crate) fn price_lines(raw: &Value) -> Result<(Vec<Value>, i64, i64, i64), Refusal> {
    let list = raw
        .as_array()
        .ok_or_else(|| Refusal::bad_request("lines must be a list"))?;
    if list.is_empty() || list.len() > 200 {
        return Err(Refusal::bad_request("lines must hold 1 to 200 lines"));
    }
    let (mut subtotal, mut discount, mut tax) = (0, 0, 0);
    let mut lines = Vec::new();
    for (i, raw) in list.iter().enumerate() {
        let priced = price_line(raw, i)?;
        subtotal += priced.total;
        discount += priced.discount;
        tax += priced.tax;
        lines.push(priced.line);
    }
    Ok((lines, subtotal, discount, tax))
}

fn money(cents: i64) -> BigDecimal {
    BigDecimal::from_str(&cents_text(cents)).unwrap_or_default()
}

// ── The body of create and update ───────────────────────────────────────────

#[derive(Debug, Default)]
#[allow(
    clippy::option_option,
    reason = "absent leaves the field, null clears it"
)]
struct QuoteBody {
    name: Option<String>,
    contact_id: Option<String>,
    currency: Option<String>,
    valid_from: Option<String>,
    valid_until: Option<String>,
    lines: Option<Value>,
    notes: Option<Option<String>>,
    payment_terms: Option<Option<String>>,
    terms: Option<Option<String>>,
    opportunity_id: Option<Option<String>>,
}

fn read_quote(body: &Value, create: bool) -> Result<QuoteBody, Refusal> {
    let fields = body
        .as_object()
        .ok_or_else(|| Refusal::bad_request("The body must be an object"))?;
    let text_of = |key: &str, max: usize| -> Result<Option<String>, Refusal> {
        match fields.get(key).filter(|v| !v.is_null()) {
            None => Ok(None),
            Some(Value::String(s)) if s.chars().count() <= max => Ok(Some(s.trim().to_owned())),
            Some(_) => Err(Refusal::bad_request(format!(
                "{key} must be text of at most {max} characters"
            ))),
        }
    };
    // `null` clears an optional text; absent leaves it.
    let clearable = |key: &str, max: usize| -> Result<Option<Option<String>>, Refusal> {
        if matches!(fields.get(key), Some(Value::Null)) {
            return Ok(Some(None));
        }
        Ok(text_of(key, max)?.map(|t| Some(t).filter(|t| !t.is_empty())))
    };
    let name = text_of("name", 255)?;
    let contact_id = text_of("contactId", 30)?;
    if create
        && (name.as_deref().is_none_or(str::is_empty)
            || contact_id.as_deref().is_none_or(str::is_empty))
    {
        return Err(Refusal::bad_request("name and contactId are required"));
    }
    if create && fields.get("lines").is_none() {
        return Err(Refusal::bad_request("lines is required"));
    }
    let currency = text_of("currency", 3)?;
    if currency
        .as_deref()
        .is_some_and(|c| c.len() != 3 || !c.bytes().all(|b| b.is_ascii_alphabetic()))
    {
        return Err(Refusal::bad_request("currency must be a three-letter code"));
    }
    Ok(QuoteBody {
        name,
        contact_id,
        currency: currency.map(|c| c.to_uppercase()),
        valid_from: text_of("validFrom", 40)?,
        valid_until: text_of("validUntil", 40)?,
        lines: fields.get("lines").filter(|v| !v.is_null()).cloned(),
        notes: clearable("notes", 10_000)?,
        payment_terms: clearable("paymentTerms", 255)?,
        terms: clearable("termsAndConditions", 20_000)?,
        opportunity_id: clearable("opportunityId", 30)?,
    })
}

/// The party a body names: its id and the CRM company and person behind it.
/// A party's id and the CRM company and person it wraps.
type PartyIds = (String, Option<String>, Option<String>);

async fn find_party(db: &PgPool, id: &str) -> Result<Option<PartyIds>, DbErr> {
    parties::Entity::find_by_id(id.to_owned())
        .filter(parties::Column::DeletedAt.is_null())
        .select_only()
        .columns([
            parties::Column::Id,
            parties::Column::CompanyId,
            parties::Column::PersonId,
        ])
        .into_tuple()
        .one(&orm(db))
        .await
}

/// `Q-<year>-<n>`: one more than the highest number of the year.
async fn next_number(db: &PgPool) -> Result<String, DbErr> {
    let year = weldsuite_events::iso_timestamp(time::OffsetDateTime::now_utc())[..4].to_owned();
    let prefix = format!("Q-{year}-");
    let numbers: Vec<String> = crm_quotes::Entity::find()
        .select_only()
        .column(crm_quotes::Column::QuoteNumber)
        .filter(crm_quotes::Column::QuoteNumber.like(format!("{prefix}%")))
        .into_tuple()
        .all(&orm(db))
        .await?;
    let highest = numbers
        .iter()
        .filter_map(|n| n.strip_prefix(&prefix)?.parse::<u32>().ok())
        .max()
        .unwrap_or(0);
    Ok(format!("{prefix}{:04}", highest + 1))
}

// ── POST / ──────────────────────────────────────────────────────────────────

async fn create(
    caller: Caller,
    State(state): State<BooksState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let result = async {
        let body = read_quote(&json_of(&headers, &body)?, true)?;
        create_quote(&caller, &state, body).await
    }
    .await;
    reply(result, "Failed to create quote")
}

async fn create_quote(caller: &Caller, state: &BooksState, body: QuoteBody) -> Reply {
    let db = &caller.db;
    let contact = body.contact_id.clone().unwrap_or_default();
    let Some((party_id, company, person)) = find_party(db, &contact).await? else {
        return Err(Refusal::bad_request("Contact not found"));
    };
    let (lines, subtotal, discount, tax) =
        price_lines(body.lines.as_ref().unwrap_or(&Value::Null))?;
    let now = utc_now();
    let valid_from = match body.valid_from.as_deref().filter(|d| !d.is_empty()) {
        Some(d) => js_timestamp(d)?,
        None => now,
    };
    let valid_until = match body.valid_until.as_deref().filter(|d| !d.is_empty()) {
        Some(d) => js_timestamp(d)?,
        None => now + time::Duration::days(30),
    };
    let id = generate_id("quote");
    let number = next_number(db).await?;
    let model = crm_quotes::ActiveModel {
        id: Set(id.clone()),
        created_at: Set(now),
        updated_at: Set(now),
        quote_number: Set(number),
        name: Set(body.name.clone().unwrap_or_default()),
        customer_id: Set(party_id),
        counterparty_id: Set(company),
        person_id: Set(person),
        opportunity_id: Set(body.opportunity_id.clone().flatten()),
        line_items: Set(Value::Array(lines)),
        subtotal: Set(money(subtotal)),
        discount: Set(Some(money(discount))),
        tax: Set(Some(money(tax))),
        shipping: Set(Some(money(0))),
        total: Set(money(subtotal + tax)),
        currency: Set(Some(
            body.currency.clone().unwrap_or_else(|| "EUR".to_owned()),
        )),
        valid_from: Set(valid_from),
        valid_until: Set(valid_until),
        status: Set("draft".to_owned()),
        payment_terms: Set(body.payment_terms.clone().flatten()),
        terms_and_conditions: Set(body.terms.clone().flatten()),
        requires_approval: Set(Some(false)),
        signature_required: Set(Some(false)),
        notes: Set(body.notes.clone().flatten()),
        deleted_at: NotSet,
        ..Default::default()
    };
    crm_quotes::Entity::insert(model)
        .exec_without_returning(&orm(db))
        .await?;
    let quote = load_quote(db, &id)
        .await?
        .ok_or_else(|| Refusal::not_found("Quote", &id))?;
    caller.publish(state, QUOTE_CREATED, &id, quote_event(&quote));
    Ok(created(detail_of(db, quote).await?))
}

fn quote_event(quote: &Value) -> Value {
    json!({
        "id": quote["id"],
        "quoteNumber": quote["quoteNumber"],
        "status": quote["status"],
        "total": quote["total"],
        "currency": quote["currency"],
    })
}

// ── PUT|PATCH /:id ──────────────────────────────────────────────────────────

async fn update(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let result = async {
        let body = read_quote(&json_of(&headers, &body)?, false)?;
        update_quote(&caller, &state, &id, body).await
    }
    .await;
    reply(result, "Failed to update quote")
}

async fn update_quote(caller: &Caller, state: &BooksState, id: &str, body: QuoteBody) -> Reply {
    let db = &caller.db;
    let Some(before) = load_quote(db, id).await? else {
        return Err(Refusal::not_found("Quote", id));
    };
    // What the customer accepted is not rewritten.
    let (status, _) = quote_status(&before, caller.now_ms());
    if status == "accepted" {
        return Err(Refusal::conflict("An accepted quote cannot be changed"));
    }
    let mut update = crm_quotes::Entity::update_many()
        .col_expr(crm_quotes::Column::UpdatedAt, Expr::value(utc_now()));
    if let Some(name) = body.name.filter(|n| !n.is_empty()) {
        update = update.col_expr(crm_quotes::Column::Name, Expr::value(name));
    }
    if let Some(contact) = body.contact_id.filter(|c| !c.is_empty()) {
        let Some((party_id, company, person)) = find_party(db, &contact).await? else {
            return Err(Refusal::bad_request("Contact not found"));
        };
        update = update
            .col_expr(crm_quotes::Column::CustomerId, Expr::value(party_id))
            .col_expr(crm_quotes::Column::CounterpartyId, Expr::value(company))
            .col_expr(crm_quotes::Column::PersonId, Expr::value(person));
    }
    if let Some(currency) = body.currency {
        update = update.col_expr(crm_quotes::Column::Currency, Expr::value(currency));
    }
    if let Some(d) = body.valid_from.filter(|d| !d.is_empty()) {
        update = update.col_expr(
            crm_quotes::Column::ValidFrom,
            Expr::value(js_timestamp(&d)?),
        );
    }
    if let Some(d) = body.valid_until.filter(|d| !d.is_empty()) {
        update = update.col_expr(
            crm_quotes::Column::ValidUntil,
            Expr::value(js_timestamp(&d)?),
        );
    }
    if let Some(lines) = &body.lines {
        let (lines, subtotal, discount, tax) = price_lines(lines)?;
        update = update
            .col_expr(
                crm_quotes::Column::LineItems,
                Expr::value(Value::Array(lines)),
            )
            .col_expr(crm_quotes::Column::Subtotal, Expr::value(money(subtotal)))
            .col_expr(crm_quotes::Column::Discount, Expr::value(money(discount)))
            .col_expr(crm_quotes::Column::Tax, Expr::value(money(tax)))
            .col_expr(
                crm_quotes::Column::Total,
                Expr::value(money(subtotal + tax)),
            );
    }
    if let Some(v) = body.notes {
        update = update.col_expr(crm_quotes::Column::Notes, Expr::value(v));
    }
    if let Some(v) = body.payment_terms {
        update = update.col_expr(crm_quotes::Column::PaymentTerms, Expr::value(v));
    }
    if let Some(v) = body.terms {
        update = update.col_expr(crm_quotes::Column::TermsAndConditions, Expr::value(v));
    }
    if let Some(v) = body.opportunity_id {
        update = update.col_expr(crm_quotes::Column::OpportunityId, Expr::value(v));
    }
    update
        .filter(crm_quotes::Column::Id.eq(id))
        .filter(crm_quotes::Column::DeletedAt.is_null())
        .exec(&orm(db))
        .await?;
    let quote = load_quote(db, id)
        .await?
        .ok_or_else(|| Refusal::not_found("Quote", id))?;
    caller.publish(state, QUOTE_UPDATED, id, quote_event(&quote));
    Ok(ok(detail_of(db, quote).await?))
}

// ── GET / ───────────────────────────────────────────────────────────────────

/// A party's id, company, person and name.
type PartyRow = (String, Option<String>, Option<String>, Option<String>);

/// Party name by the keys a quote carries: its `customerId`, `company:<id>`
/// and `person:<id>`.
async fn party_names(
    db: &PgPool,
    rows: &[Value],
) -> Result<HashMap<String, (String, String)>, DbErr> {
    let mut ids = HashSet::new();
    let mut companies = HashSet::new();
    let mut people = HashSet::new();
    for row in rows {
        let (customer, company, person) = quote_party(row);
        ids.extend(customer);
        companies.extend(company);
        people.extend(person);
    }
    let mut condition = Condition::any();
    if !ids.is_empty() {
        condition = condition.add(parties::Column::Id.is_in(ids));
    }
    if !companies.is_empty() {
        condition = condition.add(parties::Column::CompanyId.is_in(companies));
    }
    if !people.is_empty() {
        condition = condition.add(parties::Column::PersonId.is_in(people));
    }
    if condition.is_empty() {
        return Ok(HashMap::new());
    }
    let found: Vec<PartyRow> = parties::Entity::find()
        .select_only()
        .columns([
            parties::Column::Id,
            parties::Column::CompanyId,
            parties::Column::PersonId,
            parties::Column::DisplayName,
        ])
        .filter(parties::Column::DeletedAt.is_null())
        .filter(condition)
        .into_tuple()
        .all(&orm(db))
        .await?;
    let mut by_key = HashMap::new();
    for (id, company, person, name) in found {
        let entry = (id.clone(), name.unwrap_or_default());
        by_key.insert(id, entry.clone());
        if let Some(company) = company {
            by_key
                .entry(format!("company:{company}"))
                .or_insert_with(|| entry.clone());
        }
        if let Some(person) = person {
            by_key.entry(format!("person:{person}")).or_insert(entry);
        }
    }
    Ok(by_key)
}

fn party_of(names: &HashMap<String, (String, String)>, quote: &Value) -> Option<(String, String)> {
    let (customer, company, person) = quote_party(quote);
    customer
        .and_then(|c| names.get(&c))
        .or_else(|| company.and_then(|c| names.get(&format!("company:{c}"))))
        .or_else(|| person.and_then(|p| names.get(&format!("person:{p}"))))
        .cloned()
}

/// The invoices made from quotes, by quote id: `(id, number, status, total, currency, issue date, entity)`.
async fn invoices_of(
    db: &PgPool,
    quote_ids: &[String],
) -> Result<HashMap<String, Vec<Value>>, DbErr> {
    if quote_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows = invoices::Entity::find()
        .filter(invoices::Column::QuoteId.is_in(quote_ids.to_vec()))
        .filter(invoices::Column::DeletedAt.is_null())
        .order_by_asc(invoices::Column::CreatedAt)
        .all(&orm(db))
        .await?;
    let mut by_quote: HashMap<String, Vec<Value>> = HashMap::new();
    for row in rows {
        let row = row_json(row)?;
        if let Some(quote) = row["quoteId"].as_str().map(str::to_owned) {
            by_quote.entry(quote).or_default().push(json!({
                "id": row["id"], "invoiceNumber": row["invoiceNumber"], "status": row["status"],
                "type": row["type"], "total": row["total"], "subtotal": row["subtotal"], "currency": row["currency"],
                "issueDate": row["issueDate"], "entityId": row["entityId"],
            }));
        }
    }
    Ok(by_quote)
}

fn accepted_at(quote: &Value) -> Value {
    if matches!(text(quote, "status"), Some("accepted" | "invoiced"))
        || quote.get("signedAt").is_some_and(|v| !v.is_null())
    {
        quote.get("signedAt").cloned().unwrap_or(Value::Null)
    } else {
        Value::Null
    }
}

fn list_row(quote: &Value, party: Option<&(String, String)>, invoice_ids: &[Value]) -> Value {
    json!({
        "id": quote["id"],
        "quoteNumber": quote["quoteNumber"],
        "name": quote["name"],
        "contactId": party.map(|p| p.0.clone()),
        "contactName": party.map(|p| p.1.clone()),
        "total": quote["total"],
        "currency": quote["currency"],
        "status": quote["status"],
        "validUntil": quote["validUntil"],
        "sentAt": quote["sentAt"],
        "viewedAt": quote["viewedAt"],
        "acceptedAt": accepted_at(quote),
        "invoiceIds": invoice_ids,
    })
}

async fn list(caller: Caller) -> Response {
    reply(list_quotes(&caller).await, "Failed to fetch quotes")
}

async fn list_quotes(caller: &Caller) -> Reply {
    let q = caller.query();
    let page = parse_int(q.present("page").unwrap_or("1"));
    let page_size = parse_int(q.present("pageSize").unwrap_or("25")).map(|n| n.clamp(1, 100));
    let (Some(page), Some(page_size)) = (page, page_size) else {
        return Err(Refusal::bad_request("page and pageSize must be numbers"));
    };
    let page = page.max(1);
    let db = &caller.db;
    let mut condition = Condition::all().add(crm_quotes::Column::DeletedAt.is_null());
    if let Some(status) = q.present("status") {
        condition = condition.add(crm_quotes::Column::Status.eq(status));
    }
    if let Some(contact) = q.present("contactId") {
        let Some((id, company, person)) = find_party(db, contact).await? else {
            return Ok(paged(Vec::new(), 0, false, None));
        };
        let mut any = Condition::any().add(crm_quotes::Column::CustomerId.eq(id.clone()));
        if let Some(company) = company {
            any = any
                .add(crm_quotes::Column::CounterpartyId.eq(company.clone()))
                .add(crm_quotes::Column::CustomerId.eq(company));
        }
        if let Some(person) = person {
            any = any
                .add(crm_quotes::Column::PersonId.eq(person.clone()))
                .add(crm_quotes::Column::CustomerId.eq(person));
        }
        condition = condition.add(any);
    }
    if let Some(term) = q.present("search") {
        let like = format!("%{term}%");
        let named = Query::select()
            .column(parties::Column::Id)
            .from(parties::Entity)
            .and_where(parties::Column::DisplayName.like(like.clone()))
            .to_owned();
        condition = condition.add(
            Condition::any()
                .add(crm_quotes::Column::QuoteNumber.like(like.clone()))
                .add(crm_quotes::Column::Name.like(like))
                .add(crm_quotes::Column::CustomerId.in_subquery(named)),
        );
    }
    let (limit, offset) = page_window(page, page_size)?;
    let rows = crm_quotes::Entity::find()
        .filter(condition.clone())
        .order_by_desc(crm_quotes::Column::CreatedAt)
        .order_by_desc(crm_quotes::Column::Id)
        .limit(limit)
        .offset(offset)
        .all(&orm(db))
        .await?;
    let total = crm_quotes::Entity::find()
        .filter(condition)
        .count(&orm(db))
        .await?;
    let total = i64::try_from(total).unwrap_or(i64::MAX);
    let rows: Vec<Value> = rows.into_iter().map(row_json).collect::<Result<_, _>>()?;
    let names = party_names(db, &rows).await?;
    let ids: Vec<String> = rows.iter().filter_map(|r| owned(r, "id")).collect();
    let made = invoices_of(db, &ids).await?;
    let out = rows
        .iter()
        .map(|quote| {
            let invoice_ids: Vec<Value> = made
                .get(text(quote, "id").unwrap_or_default())
                .map(|list| list.iter().map(|i| i["id"].clone()).collect())
                .unwrap_or_default();
            list_row(quote, party_of(&names, quote).as_ref(), &invoice_ids)
        })
        .collect();
    Ok(paged(out, total, page * page_size < total, None))
}

// ── GET /:id ────────────────────────────────────────────────────────────────

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    reply(
        async {
            let Some(quote) = load_quote(&caller.db, &id).await? else {
                return Err(Refusal::not_found("Quote", &id));
            };
            Ok(ok(detail_of(&caller.db, quote).await?))
        }
        .await,
        "Failed to fetch quote",
    )
}

/// The quote with its contact, its lines and the invoices made from it.
async fn detail_of(db: &PgPool, quote: Value) -> Result<Value, DbErr> {
    let names = party_names(db, std::slice::from_ref(&quote)).await?;
    let id = owned(&quote, "id").unwrap_or_default();
    let made = invoices_of(db, std::slice::from_ref(&id)).await?;
    let invoices = made.get(&id).cloned().unwrap_or_default();
    let invoice_ids: Vec<Value> = invoices.iter().map(|i| i["id"].clone()).collect();
    let mut out = list_row(&quote, party_of(&names, &quote).as_ref(), &invoice_ids);
    if let (Value::Object(out), Value::Object(quote)) = (&mut out, &quote) {
        for key in [
            "subtotal",
            "discount",
            "tax",
            "validFrom",
            "paymentTerms",
            "termsAndConditions",
            "notes",
            "signedBy",
            "signedAt",
            "opportunityId",
            "createdAt",
            "updatedAt",
        ] {
            out.insert(
                key.to_owned(),
                quote.get(key).cloned().unwrap_or(Value::Null),
            );
        }
        out.insert(
            "lines".into(),
            quote.get("lineItems").cloned().unwrap_or_else(|| json!([])),
        );
        out.insert("invoices".into(), Value::Array(invoices));
    }
    Ok(out)
}

// ── POST /api/invoices/from-quote/:quoteId ──────────────────────────────────

/// The checked body of `from-quote`.
#[derive(Debug, Default)]
pub(crate) struct FromQuote {
    pub entity_id: Option<String>,
    pub percentage: Option<f64>,
    pub lines: Option<Vec<Value>>,
}

pub(crate) fn read_from_quote(body: &Value) -> Result<FromQuote, Refusal> {
    let fields = match body {
        Value::Null => return Ok(FromQuote::default()),
        Value::Object(fields) => fields,
        _ => return Err(Refusal::bad_request("The body must be an object")),
    };
    let entity_id = match fields.get("entityId").filter(|v| !v.is_null()) {
        None => None,
        Some(Value::String(s)) if !s.is_empty() && s.len() <= 30 => Some(s.clone()),
        Some(_) => return Err(Refusal::bad_request("entityId must be an entity id")),
    };
    let percentage = match fields.get("percentage").filter(|v| !v.is_null()) {
        None => None,
        Some(v) => Some(
            number(Some(v))
                .filter(|p| (1.0..=100.0).contains(p))
                .ok_or_else(|| Refusal::bad_request("percentage must be a number from 1 to 100"))?,
        ),
    };
    let lines = match fields.get("lines").filter(|v| !v.is_null()) {
        None => None,
        Some(Value::Array(list)) if !list.is_empty() && list.len() <= 200 => Some(list.clone()),
        Some(_) => return Err(Refusal::bad_request("lines must hold 1 to 200 lines")),
    };
    Ok(FromQuote {
        entity_id,
        percentage,
        lines,
    })
}

/// A stored or overriding line as an invoice line, its price scaled to
/// `percentage` percent (to four decimals).
pub(crate) fn invoice_line(
    line: &Value,
    percentage: f64,
    index: usize,
) -> Result<LineInput, Refusal> {
    let priced = price_line(line, index)?;
    let l = &priced.line;
    let price = number(l.get("unitPrice")).unwrap_or(0.0);
    let scaled = if (percentage - 100.0).abs() < f64::EPSILON {
        price
    } else {
        (price * percentage / 100.0 * 10_000.0).round() / 10_000.0
    };
    let field = |key: &str| owned(l, key);
    Ok(LineInput {
        description: field("description").unwrap_or_default(),
        quantity: field("quantity").unwrap_or_else(|| "1".to_owned()),
        unit_price: plain(scaled),
        unit: field("unit"),
        discount_percent: field("discountPercent").unwrap_or_else(|| "0".to_owned()),
        tax_rate_id: field("taxRateId"),
        tax_rate: field("taxRate").filter(|r| r != "0"),
        account_id: field("accountId"),
        product_id: field("productId"),
        sort_order: Some(f64::from(u32::try_from(index).unwrap_or(u32::MAX))),
        ..LineInput::default()
    })
}

pub(crate) async fn from_quote(
    caller: Caller,
    State(state): State<BooksState>,
    Path(quote_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let result = async {
        let parsed = if body.is_empty() {
            Value::Null
        } else {
            json_of(&headers, &body)?
        };
        let body = read_from_quote(&parsed)?;
        invoice_from_quote(&caller, &state, &quote_id, body)
            .await
            .map_err(Refusal::from)
    }
    .await;
    reply(result, "Failed to create invoice from quote")
}

/// Days from `paymentTerms` text such as `net30` or `14 days`, else 14.
fn terms_days(terms: Option<&str>) -> i64 {
    terms
        .map(|t| t.chars().filter(char::is_ascii_digit).collect::<String>())
        .and_then(|d| d.parse::<i64>().ok())
        .filter(|d| (0..=365).contains(d))
        .unwrap_or(14)
}

#[allow(
    clippy::too_many_lines,
    reason = "the route's steps in order: checks, lines, invoice, link, quote"
)]
pub(crate) async fn invoice_from_quote(
    caller: &Caller,
    state: &BooksState,
    quote_id: &str,
    body: FromQuote,
) -> Result<Response, SalesError> {
    let db = &caller.db;
    let Some(quote) = load_quote(db, quote_id).await? else {
        return Err(Refusal::not_found("Quote", quote_id).into());
    };
    let status = text(&quote, "status").unwrap_or_default().to_owned();
    if matches!(status.as_str(), "declined" | "rejected" | "cancelled") {
        return Err(Refusal::conflict("A declined or cancelled quote cannot be invoiced").into());
    }
    let Some(entity_id) = resolve_requested_entity_id(caller, body.entity_id.as_deref()).await?
    else {
        return Err(Refusal::bad_request(
            "No accounting entity resolved — name one in entityId or configure a default entity.",
        )
        .into());
    };
    let Some(party_id) = quote_party_id(db, &quote).await? else {
        return Err(Refusal::bad_request("The quote has no WeldBooks contact to invoice").into());
    };
    let party = find_party_terms(db, &party_id).await?;
    let percentage = body.percentage.unwrap_or(100.0);
    let quote_subtotal = parse_cents(&decimal(quote.get("subtotal"), "0")).unwrap_or(0);

    // How much of the quote is invoiced already (subtotals, credit notes and cancelled ones aside).
    let made = invoices_of(db, &[quote_id.to_owned()]).await?;
    let invoiced: i64 = made.get(quote_id).map_or(0, |list| {
        list.iter()
            .filter(|i| i["type"] != "credit_note" && i["status"] != "cancelled")
            .filter_map(|i| parse_cents(&decimal(i.get("subtotal"), "0")))
            .sum()
    });
    #[allow(clippy::cast_precision_loss)]
    let invoiced_percentage = if quote_subtotal > 0 {
        invoiced as f64 * 100.0 / quote_subtotal as f64
    } else {
        0.0
    };
    if body.lines.is_none() && invoiced_percentage + percentage > 100.01 {
        return Err(Refusal::conflict(format!(
            "{invoiced_percentage:.0}% of this quote is invoiced already; at most {:.0}% is left",
            (100.0 - invoiced_percentage).max(0.0)
        ))
        .into());
    }
    let source: Vec<Value> = match &body.lines {
        Some(lines) => lines.clone(),
        None => quote
            .get("lineItems")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
    };
    if source.is_empty() {
        return Err(Refusal::bad_request("The quote has no lines to invoice").into());
    }
    let scale = if body.lines.is_some() {
        100.0
    } else {
        percentage
    };
    let items: Vec<LineInput> = source
        .iter()
        .enumerate()
        .map(|(i, line)| invoice_line(line, scale, i))
        .collect::<Result<_, _>>()?;

    let today = weldsuite_events::iso_timestamp(time::OffsetDateTime::now_utc());
    let days = terms_days(party.as_deref());
    let due = weldsuite_events::iso_timestamp(
        time::OffsetDateTime::now_utc() + time::Duration::days(days),
    );
    let number = owned(&quote, "quoteNumber").unwrap_or_default();
    let partial = body.lines.is_none() && percentage < 100.0;
    let input = InvoiceInput {
        status: Some("draft".to_owned()),
        contact_id: Some(party_id),
        issue_date: Some(today),
        due_date: Some(due),
        currency: owned(&quote, "currency"),
        payment_terms_days: Some(f64::from(u32::try_from(days).unwrap_or(14))),
        reference: Some(number.clone()),
        notes: Some(if partial {
            format!("Advance invoice of {percentage:.0}% of quote {number}")
        } else {
            format!("Quote {number}")
        }),
        items: Some(items),
        ..InvoiceInput::default()
    };
    let mut invoice =
        crate::invoices::write::create_in_entity(caller, state, input, entity_id).await?;
    let invoice_id = owned(&invoice, "id").unwrap_or_default();
    invoices::Entity::update_many()
        .col_expr(invoices::Column::QuoteId, Expr::value(quote_id.to_owned()))
        .filter(invoices::Column::Id.eq(invoice_id.as_str()))
        .exec(&orm(db))
        .await
        .map_err(Refusal::from)?;
    invoice["quoteId"] = json!(quote_id);

    // 100% invoiced: the quote is done (a share the lines override never closes it).
    if body.lines.is_none() && invoiced_percentage + percentage >= 99.99 && status != "invoiced" {
        crm_quotes::Entity::update_many()
            .col_expr(crm_quotes::Column::Status, Expr::value("invoiced"))
            .col_expr(crm_quotes::Column::UpdatedAt, Expr::value(utc_now()))
            .filter(crm_quotes::Column::Id.eq(quote_id))
            .exec(&orm(db))
            .await
            .map_err(Refusal::from)?;
        let mut data = quote_event(&quote);
        data["status"] = json!("invoiced");
        caller.publish(state, QUOTE_UPDATED, quote_id, data);
    }
    Ok(created(invoice))
}

/// The contact's payment terms text.
async fn find_party_terms(db: &PgPool, id: &str) -> Result<Option<String>, DbErr> {
    let terms: Option<Option<String>> = parties::Entity::find_by_id(id.to_owned())
        .select_only()
        .column(parties::Column::PaymentTerms)
        .into_tuple()
        .one(&orm(db))
        .await?;
    Ok(terms.flatten())
}

#[cfg(test)]
mod db_tests;

#[cfg(test)]
#[allow(clippy::unwrap_used, reason = "tests")]
mod tests {
    use super::*;

    #[test]
    fn a_line_is_priced_in_cents_and_stored_as_text() {
        let p = price_line(&json!({ "description": "Work", "quantity": 3, "unitPrice": "33.33", "discountPercent": 10, "taxRate": 21 }), 0).unwrap();
        // 3 x 33.33 = 99.99, less 10% = 89.99 (rounded), tax 21% = 18.90.
        assert_eq!(p.total, 8_999);
        assert_eq!(p.discount, 1_000);
        assert_eq!(p.tax, 1_890);
        assert_eq!(p.line["lineTotal"], "89.99");
        assert_eq!(p.line["quantity"], "3");
        assert_eq!(p.line["taxRate"], "21");
    }

    #[test]
    fn a_bad_line_is_refused() {
        for line in [
            json!({ "unitPrice": 1 }),
            json!({ "description": "x" }),
            json!({ "description": "x", "unitPrice": 1, "quantity": 0 }),
            json!({ "description": "x", "unitPrice": 1, "discountPercent": 101 }),
            json!({ "description": "x", "unitPrice": 1, "taxRate": -1 }),
            json!("x"),
        ] {
            assert!(price_line(&line, 2).is_err(), "{line}");
        }
        assert!(price_lines(&json!([])).is_err());
        assert!(price_lines(&json!("x")).is_err());
    }

    #[test]
    fn the_lines_sum_into_the_totals() {
        let (lines, subtotal, discount, tax) = price_lines(&json!([
            { "description": "A", "quantity": 2, "unitPrice": 50, "taxRate": 21 },
            { "description": "B", "unitPrice": 10, "discountPercent": 50, "taxRate": 9 },
        ]))
        .unwrap();
        assert_eq!(lines.len(), 2);
        assert_eq!(subtotal, 10_500);
        assert_eq!(discount, 500);
        assert_eq!(tax, 2_100 + 45);
    }

    #[test]
    fn from_quote_checks_its_body() {
        assert_eq!(read_from_quote(&Value::Null).unwrap().percentage, None);
        let read = read_from_quote(&json!({ "entityId": "ent_1", "percentage": 30 })).unwrap();
        assert_eq!(read.entity_id.as_deref(), Some("ent_1"));
        assert!((read.percentage.unwrap() - 30.0).abs() < f64::EPSILON);
        for bad in [
            json!({ "percentage": 0 }),
            json!({ "percentage": 101 }),
            json!({ "percentage": "x" }),
            json!({ "entityId": 3 }),
            json!({ "lines": [] }),
            json!([]),
        ] {
            assert!(read_from_quote(&bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_share_scales_the_unit_price() {
        let line =
            json!({ "description": "Build", "quantity": 2, "unitPrice": "1000", "taxRate": 21 });
        let half = invoice_line(&line, 50.0, 0).unwrap();
        assert_eq!(half.unit_price, "500");
        assert_eq!(half.quantity, "2");
        assert_eq!(half.tax_rate.as_deref(), Some("21"));
        let third = invoice_line(&line, 33.0, 1).unwrap();
        assert_eq!(third.unit_price, "330");
        let whole = invoice_line(&line, 100.0, 0).unwrap();
        assert_eq!(whole.unit_price, "1000");
    }

    #[test]
    fn payment_terms_text_gives_days() {
        assert_eq!(terms_days(Some("net30")), 30);
        assert_eq!(terms_days(Some("14 dagen")), 14);
        assert_eq!(terms_days(Some("on receipt")), 14);
        assert_eq!(terms_days(None), 14);
    }
}
