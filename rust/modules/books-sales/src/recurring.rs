//! `/api/recurring-invoices` (`routes/recurring-invoices/index.ts`,
//! `services/accounting-recurring.ts`): recurring schedules, paused and
//! resumed, and the next invoice generated from the template. The period is
//! claimed first (`nextIssueDate` moves only if it still holds what was
//! read), so two runs never bill the same period twice; the invoice gets the
//! same tax calculation as a manual one, and `autoFinalize` schedules post it
//! straight away (a failure leaves it a draft with `finalizeError`).

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::Response;
use axum::routing::{get, patch, post};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_books_domain::address::normalize_postal_address;
use weldsuite_books_domain::books_row;
use weldsuite_books_domain::entity_context::{
    SequenceType, next_entity_number, resolve_entity_base_currency, resolve_entity_id,
};
use weldsuite_books_domain::guards::{AuditInput, change, write_accounting_audit};
use weldsuite_books_domain::http::{
    BooksState, Caller, Refusal, Reply, created, no_content, now, ok, reply, validate,
    validate_value,
};
use weldsuite_books_domain::js;
use weldsuite_books_domain::sales_tax::document_tax::{DocumentContext, DocumentKind, IssueDate};
use weldsuite_books_domain::tables::{INVOICE_ITEMS, INVOICES, RECURRING_INVOICES};
use weldsuite_books_domain::tax::{DocumentTaxItem, SupplyArgs, TaxArgs, resolve_gst_supply};
use weldsuite_catalogs::entity_events::{
    RECURRING_INVOICE_CREATED, RECURRING_INVOICE_DELETED, RECURRING_INVOICE_UPDATED,
};
use weldsuite_kit::generate_id;
use weldsuite_kit::validation::{Issues, Number, Presence};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::body::{br_document_fiscal, br_line_fiscal, cfop, ncm, read_currency};
use crate::errors::SalesError;
use crate::finalize::{FinalizeOptions, finalize_invoice};
use crate::invoices::write::runtime;
use crate::persist::{
    Drafted, calculate_draft_tax, engine_unavailable_warning, invoice_tax_columns,
    item_tax_columns, text,
};

const DAY_MS: i64 = 24 * 60 * 60 * 1000;

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
            "/{id}",
            axum::routing::delete(remove).route_layer(need("invoices:delete")),
        )
        .route(
            "/{id}/pause",
            patch(pause).route_layer(need("invoices:update")),
        )
        .route(
            "/{id}/resume",
            patch(resume).route_layer(need("invoices:update")),
        )
        .route(
            "/{id}/generate",
            post(generate).route_layer(need("invoices:create")),
        )
        .with_state(state)
}

const FREQUENCIES: &[&str] = &[
    "weekly",
    "biweekly",
    "monthly",
    "quarterly",
    "biannually",
    "yearly",
];

fn put(out: &mut Map<String, Value>, key: &str, value: Option<Value>) {
    if let Some(value) = value {
        out.insert(key.to_owned(), value);
    }
}

/// `templateAddressSchema` at `shipFromAddress` (nullish).
fn template_address(issues: &mut Issues, body: &Map<String, Value>) -> Option<Value> {
    match issues.nested(
        body,
        "shipFromAddress",
        Presence::Nullish,
        |issues, fields| {
            let mut out = Map::new();
            for key in [
                "line1",
                "line2",
                "city",
                "state",
                "postalCode",
                "country",
                "county",
            ] {
                let value = issues
                    .text(fields, key, Presence::Optional, None, None)
                    .into_option();
                put(&mut out, key, value.map(Value::String));
            }
            Value::Object(out)
        },
    ) {
        weldsuite_kit::validation::Field::Set(value) => Some(value),
        weldsuite_kit::validation::Field::Null => Some(Value::Null),
        weldsuite_kit::validation::Field::Absent => None,
    }
}

/// `recurringTemplateSchema`: the parsed template (Zod's output object).
pub(crate) fn read_template(issues: &mut Issues, body: &Map<String, Value>) -> Value {
    let mut out = Map::new();
    let items =
        issues.list(
            body,
            "items",
            Presence::Optional,
            None,
            None,
            |issues, item| {
                let fields = issues.object(item)?;
                let mut line = Map::new();
                let nullish_id = |issues: &mut Issues, key: &str, max: Option<usize>| match issues
                    .text(fields, key, Presence::Nullish, None, max)
                {
                    weldsuite_kit::validation::Field::Set(v) => Some(Value::String(v)),
                    weldsuite_kit::validation::Field::Null => Some(Value::Null),
                    weldsuite_kit::validation::Field::Absent => None,
                };
                let description = issues
                    .text(fields, "description", Presence::Required, None, None)
                    .into_option();
                put(&mut line, "description", description.map(Value::String));
                let quantity = issues
                    .number(fields, "quantity", Presence::Required, Number::default())
                    .into_option();
                put(&mut line, "quantity", quantity.map(js::number_value));
                let price = issues
                    .number(fields, "unitPrice", Presence::Required, Number::default())
                    .into_option();
                put(&mut line, "unitPrice", price.map(js::number_value));
                let unit = issues
                    .text(fields, "unit", Presence::Optional, None, None)
                    .into_option();
                put(&mut line, "unit", unit.map(Value::String));
                let tax_rate_id = nullish_id(issues, "taxRateId", None);
                put(&mut line, "taxRateId", tax_rate_id);
                let account_id = nullish_id(issues, "accountId", None);
                put(&mut line, "accountId", account_id);
                let product_id = nullish_id(issues, "productId", Some(30));
                put(&mut line, "productId", product_id);
                let tax_code = nullish_id(issues, "taxCode", Some(30));
                put(&mut line, "taxCode", tax_code);
                let tax_use = issues.choice(
                    fields,
                    "taxUse",
                    Presence::Nullish,
                    &["business", "personal"],
                );
                put(&mut line, "taxUse", field_json(tax_use.map_string()));
                let included = issues
                    .boolean(fields, "taxIncluded", Presence::Optional)
                    .into_option();
                put(&mut line, "taxIncluded", included.map(Value::Bool));
                let hsn = issues.pattern(
                    fields,
                    "hsnSac",
                    Presence::Nullish,
                    None,
                    None,
                    |t| {
                        t.is_empty()
                            || ((4..=8).contains(&t.len()) && t.bytes().all(|b| b.is_ascii_digit()))
                    },
                    "Invalid",
                );
                put(&mut line, "hsnSac", field_json(hsn.map_string()));
                let ncm = ncm(issues, fields);
                put(&mut line, "ncm", field_json(ncm.map_string()));
                let cfop = cfop(issues, fields);
                put(&mut line, "cfop", field_json(cfop.map_string()));
                let fiscal = br_line_fiscal(issues, fields);
                put(&mut line, "fiscalData", field_json(fiscal));
                let class_id = nullish_id(issues, "classId", Some(30));
                put(&mut line, "classId", class_id);
                let location_id = nullish_id(issues, "locationId", Some(30));
                put(&mut line, "locationId", location_id);
                Some(Value::Object(line))
            },
        );
    put(&mut out, "items", items.into_option().map(Value::Array));
    put(&mut out, "shipFromAddress", template_address(issues, body));
    for key in ["notes", "internalNotes"] {
        let value = issues
            .text(body, key, Presence::Optional, None, None)
            .into_option();
        put(&mut out, key, value.map(Value::String));
    }
    let terms = issues
        .number(
            body,
            "paymentTermsDays",
            Presence::Optional,
            Number::default(),
        )
        .into_option();
    put(&mut out, "paymentTermsDays", terms.map(js::number_value));
    for key in ["revenueAccountId", "reference"] {
        let value = issues
            .text(body, key, Presence::Optional, None, None)
            .into_option();
        put(&mut out, key, value.map(Value::String));
    }
    put(
        &mut out,
        "currency",
        read_currency(issues, body).map(Value::String),
    );
    put(
        &mut out,
        "fiscalData",
        field_json(br_document_fiscal(issues, body)),
    );
    Value::Object(out)
}

trait MapString {
    fn map_string(self) -> weldsuite_kit::validation::Field<Value>;
}

impl MapString for weldsuite_kit::validation::Field<String> {
    fn map_string(self) -> weldsuite_kit::validation::Field<Value> {
        match self {
            weldsuite_kit::validation::Field::Set(v) => {
                weldsuite_kit::validation::Field::Set(Value::String(v))
            }
            weldsuite_kit::validation::Field::Null => weldsuite_kit::validation::Field::Null,
            weldsuite_kit::validation::Field::Absent => weldsuite_kit::validation::Field::Absent,
        }
    }
}

fn field_json(field: weldsuite_kit::validation::Field<Value>) -> Option<Value> {
    match field {
        weldsuite_kit::validation::Field::Set(v) => Some(v),
        weldsuite_kit::validation::Field::Null => Some(Value::Null),
        weldsuite_kit::validation::Field::Absent => None,
    }
}

/// `createRecurringSchema` (`partial` for an update), as Zod outputs it.
fn read_recurring(
    issues: &mut Issues,
    body: &Map<String, Value>,
    partial: bool,
) -> Map<String, Value> {
    let required = if partial {
        Presence::Optional
    } else {
        Presence::Required
    };
    let mut out = Map::new();
    let name = issues
        .text(body, "name", Presence::Optional, None, Some(255))
        .into_option();
    put(&mut out, "name", name.map(Value::String));
    let contact = issues
        .text(body, "contactId", required, Some(1), None)
        .into_option();
    put(&mut out, "contactId", contact.map(Value::String));
    let frequency = issues
        .choice(body, "frequency", required, FREQUENCIES)
        .into_option();
    put(&mut out, "frequency", frequency.map(Value::String));
    let day = issues
        .number(
            body,
            "dayOfMonth",
            Presence::Optional,
            Number {
                min: Some(1.0),
                max: Some(31.0),
                ..Number::default()
            },
        )
        .into_option();
    put(&mut out, "dayOfMonth", day.map(js::number_value));
    let next = issues
        .text(body, "nextIssueDate", required, None, None)
        .into_option();
    put(&mut out, "nextIssueDate", next.map(Value::String));
    let end = issues
        .text(body, "endDate", Presence::Optional, None, None)
        .into_option();
    put(&mut out, "endDate", end.map(Value::String));
    for key in ["autoSend", "autoFinalize"] {
        let flag = issues.boolean(body, key, Presence::Optional).into_option();
        put(&mut out, key, flag.map(Value::Bool));
    }
    let template = issues
        .nested(body, "templateData", Presence::Optional, read_template)
        .into_option();
    put(&mut out, "templateData", template);
    out
}

async fn load(db: &weldsuite_db::PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        books_row!(recurring_invoices),
        " from recurring_invoices t where t.id = $1 and t.deleted_at is null limit 1"
    ))
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(|r| RECURRING_INVOICES.js(r)))
}

async fn audit(
    caller: &Caller,
    entity_id: Option<&str>,
    id: &str,
    action: &str,
    changes: Option<Map<String, Value>>,
) {
    write_accounting_audit(
        caller,
        &caller.db,
        AuditInput {
            accounting_entity_id: entity_id,
            entity_type: "recurring_invoice",
            entity_id: id,
            action,
            changes,
        },
    )
    .await;
}

async fn list(caller: Caller) -> Response {
    reply(
        async {
            let Some(entity_id) = resolve_entity_id(&caller).await? else {
                return Err(Refusal::bad_request("No accounting entity resolved"));
            };
            let rows: Vec<Value> = sqlx::query_scalar(concat!(
                "select ",
                books_row!(recurring_invoices),
                " from recurring_invoices t where t.deleted_at is null and t.entity_id = $1 order by t.created_at desc"
            ))
            .bind(&entity_id)
            .fetch_all(&caller.db)
            .await?;
            Ok(ok(Value::Array(RECURRING_INVOICES.js_rows(rows))))
        }
        .await,
        "Failed to fetch recurring invoices",
    )
}

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    reply(
        async {
            match load(&caller.db, &id).await? {
                Some(row) => Ok(ok(row)),
                None => Err(Refusal::not_found("Recurring invoice", &id)),
            }
        }
        .await,
        "Failed to fetch recurring invoice",
    )
}

fn js_date(text: &str) -> Result<String, Refusal> {
    js::js_date(text).ok_or_else(|| Refusal::Internal("Invalid time value".to_owned()))
}

async fn create(
    caller: Caller,
    State(state): State<BooksState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, |issues, b| {
        read_recurring(issues, b, false)
    }) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond("Failed to create recurring invoice"),
    };
    reply(
        async {
            let Some(entity_id) = resolve_entity_id(&caller).await? else {
                return Err(Refusal::bad_request("No accounting entity resolved"));
            };
            let at = now();
            let id = generate_id("ri");
            let mut row = Map::new();
            row.insert("id".into(), json!(id));
            row.insert("entityId".into(), json!(entity_id));
            for (key, value) in &data {
                row.insert(key.clone(), value.clone());
            }
            row.insert(
                "nextIssueDate".into(),
                json!(js_date(data["nextIssueDate"].as_str().unwrap_or_default())?),
            );
            let end = match data
                .get("endDate")
                .and_then(Value::as_str)
                .filter(|e| !e.is_empty())
            {
                Some(end) => json!(js_date(end)?),
                None => Value::Null,
            };
            row.insert("endDate".into(), end);
            row.insert("status".into(), json!("active"));
            row.insert("generatedCount".into(), json!(0));
            row.insert("createdBy".into(), json!(caller.user_id));
            row.insert("createdAt".into(), json!(at));
            row.insert("updatedAt".into(), json!(at));
            RECURRING_INVOICES
                .insert_raw(&caller.db, RECURRING_INVOICES.values(&row))
                .await?;
            audit(&caller, Some(&entity_id), &id, "created", None).await;
            caller.publish(
                &state,
                RECURRING_INVOICE_CREATED,
                &id,
                Value::Object(row.clone()),
            );
            Ok(created(Value::Object(row)))
        }
        .await,
        "Failed to create recurring invoice",
    )
}

async fn update(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, |issues, b| read_recurring(issues, b, true)) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond("Failed to update recurring invoice"),
    };
    reply(
        async {
            let db = &caller.db;
            let Some(rec) = load(db, &id).await? else {
                return Err(Refusal::not_found("Recurring invoice", &id));
            };
            let mut update = data.clone();
            update.insert("updatedAt".into(), json!(now()));
            if let Some(next) = data
                .get("nextIssueDate")
                .and_then(Value::as_str)
                .filter(|n| !n.is_empty())
            {
                update.insert("nextIssueDate".into(), json!(js_date(next)?));
            }
            if let Some(end) = data
                .get("endDate")
                .and_then(Value::as_str)
                .filter(|e| !e.is_empty())
            {
                update.insert("endDate".into(), json!(js_date(end)?));
            }
            RECURRING_INVOICES
                .patch_raw(db, &id, RECURRING_INVOICES.values(&update), false)
                .await?;
            let changes: Map<String, Value> = update
                .iter()
                .filter(|(k, _)| k.as_str() != "updatedAt")
                .map(|(k, v)| {
                    (
                        k.clone(),
                        change(rec.get(k).cloned().unwrap_or(Value::Null), v.clone()),
                    )
                })
                .collect();
            audit(
                &caller,
                rec["entityId"].as_str(),
                &id,
                "updated",
                Some(changes),
            )
            .await;
            let mut merged = rec.as_object().cloned().unwrap_or_default();
            merged.extend(update);
            caller.publish(
                &state,
                RECURRING_INVOICE_UPDATED,
                &id,
                Value::Object(merged.clone()),
            );
            Ok(ok(Value::Object(merged)))
        }
        .await,
        "Failed to update recurring invoice",
    )
}

async fn remove(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
) -> Response {
    reply(
        async {
            let db = &caller.db;
            let Some(rec) = load(db, &id).await? else {
                return Err(Refusal::not_found("Recurring invoice", &id));
            };
            sqlx::query("update recurring_invoices set deleted_at = $1::timestamp, updated_at = $1::timestamp where id = $2")
                .bind(now())
                .bind(&id)
                .execute(db)
                .await?;
            audit(&caller, rec["entityId"].as_str(), &id, "deleted", None).await;
            caller.publish(&state, RECURRING_INVOICE_DELETED, &id, json!({ "id": id }));
            Ok(no_content())
        }
        .await,
        "Failed to delete recurring invoice",
    )
}

async fn set_status(
    caller: &Caller,
    state: &BooksState,
    id: &str,
    status: &str,
    action: &str,
) -> Reply {
    let db = &caller.db;
    let Some(rec) = load(db, id).await? else {
        return Err(Refusal::not_found("Recurring invoice", id));
    };
    sqlx::query(
        "update recurring_invoices set status = $1, updated_at = $2::timestamp where id = $3",
    )
    .bind(status)
    .bind(now())
    .bind(id)
    .execute(db)
    .await?;
    let mut changes = Map::new();
    changes.insert(
        "status".into(),
        change(rec["status"].clone(), json!(status)),
    );
    audit(caller, rec["entityId"].as_str(), id, action, Some(changes)).await;
    caller.publish(
        state,
        RECURRING_INVOICE_UPDATED,
        id,
        json!({ "id": id, "status": status }),
    );
    Ok(ok(json!({ "status": status })))
}

async fn pause(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
) -> Response {
    reply(
        set_status(&caller, &state, &id, "paused", "paused").await,
        "Failed to pause recurring invoice",
    )
}

async fn resume(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
) -> Response {
    reply(
        set_status(&caller, &state, &id, "active", "resumed").await,
        "Failed to resume recurring invoice",
    )
}

// ── POST /:id/generate ──────────────────────────────────────────────────────

/// `nextScheduleDate(from, frequency)` in the Workers' local time (UTC).
pub(crate) fn next_schedule_date(from_ms: i64, frequency: &str) -> i64 {
    let days = from_ms.div_euclid(DAY_MS);
    let time = from_ms.rem_euclid(DAY_MS);
    let (y, m, d) = js::civil_from_days(days);
    let add_months = |months: i64| {
        // `setMonth`: the day overflows into the next month, as in JavaScript.
        let total = y * 12 + (m - 1) + months;
        let (ny, nm) = (total.div_euclid(12), total.rem_euclid(12) + 1);
        js::days_from_civil(ny, nm, 1) + (d - 1)
    };
    let new_days = match frequency {
        "weekly" => days + 7,
        "biweekly" => days + 14,
        "monthly" => add_months(1),
        "quarterly" => add_months(3),
        "biannually" => add_months(6),
        "yearly" => add_months(12),
        _ => days,
    };
    new_days * DAY_MS + time
}

/// `GeneratedRecurringInvoice`.
pub(crate) struct Generated {
    pub invoice_id: String,
    pub invoice_number: String,
    pub next_issue_date: String,
    pub status: &'static str,
    pub journal_entry_id: Option<String>,
    pub finalize_error: Option<String>,
}

async fn generate(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
) -> Response {
    reply(
        generate_route(&caller, &state, &id).await,
        "Failed to generate recurring invoice",
    )
}

async fn generate_route(caller: &Caller, state: &BooksState, id: &str) -> Reply {
    let db = &caller.db;
    let Some(rec) = load(db, id).await? else {
        return Err(Refusal::not_found("Recurring invoice", id));
    };
    if text(&rec, "status") != Some("active") {
        return Err(Refusal::bad_request("Recurring invoice is not active"));
    }
    let resolved = resolve_entity_id(caller).await?;
    if let Some(resolved) = resolved
        && text(&rec, "entityId").is_some_and(|e| !e.is_empty() && e != resolved)
    {
        return Err(Refusal::bad_request(
            "Recurring invoice belongs to a different accounting entity",
        ));
    }
    let generated = match generate_recurring_invoice(caller, state, &rec).await {
        Ok(generated) => generated,
        Err(GenerateError::AlreadyGenerated) => {
            return Err(Refusal::conflict(
                "This period was already generated — reload the schedule to see its next issue date.",
            ));
        }
        Err(GenerateError::Sales(error)) => return Err(error.into()),
    };
    let count = rec["generatedCount"].as_i64().unwrap_or(0) + 1;
    let mut changes = Map::new();
    changes.insert(
        "lastGeneratedInvoiceId".into(),
        change(
            rec["lastGeneratedInvoiceId"].clone(),
            json!(generated.invoice_id),
        ),
    );
    changes.insert(
        "generatedCount".into(),
        change(rec["generatedCount"].clone(), json!(count)),
    );
    changes.insert(
        "status".into(),
        change(rec["status"].clone(), json!(generated.status)),
    );
    audit(
        caller,
        rec["entityId"].as_str(),
        id,
        "generated",
        Some(changes),
    )
    .await;
    caller.publish(
        state,
        RECURRING_INVOICE_UPDATED,
        id,
        json!({
            "id": id,
            "invoiceId": generated.invoice_id,
            "invoiceNumber": generated.invoice_number,
            "nextIssueDate": generated.next_issue_date,
            "status": generated.status,
            "generatedCount": count,
        }),
    );
    Ok(created(json!({
        "invoiceId": generated.invoice_id,
        "invoiceNumber": generated.invoice_number,
        "nextIssueDate": generated.next_issue_date,
        "status": generated.status,
        "journalEntryId": generated.journal_entry_id,
        "finalizeError": generated.finalize_error,
    })))
}

pub(crate) enum GenerateError {
    /// `RecurringAlreadyGeneratedError`.
    AlreadyGenerated,
    Sales(SalesError),
}

impl<E: Into<SalesError>> From<E> for GenerateError {
    fn from(error: E) -> Self {
        Self::Sales(error.into())
    }
}

/// `generateRecurringInvoice(db, rec, opts)`.
#[allow(
    clippy::too_many_lines,
    reason = "the service's steps in its order: claim, template, tax, rows, finalize"
)]
pub(crate) async fn generate_recurring_invoice(
    caller: &Caller,
    state: &BooksState,
    rec: &Value,
) -> Result<Generated, GenerateError> {
    let db = &caller.db;
    if text(rec, "status") != Some("active") {
        return Err(SalesError::posting("Recurring invoice is not active").into());
    }
    let at = now();
    let at_ms = js::millis_of(&at).unwrap_or(0);
    let entity_id = text(rec, "entityId").unwrap_or_default().to_owned();
    let current_next = text(rec, "nextIssueDate").unwrap_or_default().to_owned();
    let next_ms = next_schedule_date(
        js::millis_of(&current_next).unwrap_or(0),
        text(rec, "frequency").unwrap_or_default(),
    );
    let next_iso = js::iso_from_millis(next_ms).unwrap_or_default();
    let ended = text(rec, "endDate")
        .and_then(js::millis_of)
        .is_some_and(|end| next_ms > end);
    let status: &'static str = if ended { "completed" } else { "active" };

    // claimPeriod: only the run that still sees the old nextIssueDate wins.
    let claimed: Option<String> = sqlx::query_scalar(
        "update recurring_invoices set next_issue_date = $1::timestamp, status = $2, updated_at = $3::timestamp \
         where id = $4 and next_issue_date = $5::timestamp returning id",
    )
    .bind(&next_iso)
    .bind(status)
    .bind(&at)
    .bind(text(rec, "id").unwrap_or_default())
    .bind(&current_next)
    .fetch_optional(db)
    .await
    .map_err(SalesError::from)?;
    if claimed.is_none() {
        return Err(GenerateError::AlreadyGenerated);
    }

    let raw = rec
        .get("templateData")
        .filter(|t| !t.is_null())
        .cloned()
        .unwrap_or_else(|| json!({}));
    let template = validate_value(&raw, |issues, body| read_template(issues, body))
        .unwrap_or_else(|_| json!({}));
    let currency = match template["currency"].as_str().filter(|c| !c.is_empty()) {
        Some(c) => c.to_owned(),
        None => resolve_entity_base_currency(db, &entity_id)
            .await
            .map_err(SalesError::from)?,
    };
    let items: Vec<Value> = template["items"].as_array().cloned().unwrap_or_default();
    let terms = template["paymentTermsDays"]
        .as_f64()
        .filter(|t| *t != 0.0 && !t.is_nan())
        .unwrap_or(30.0);
    let contact_id = text(rec, "contactId").unwrap_or_default().to_owned();
    let contact: Option<(Option<String>, Option<Value>, Option<Value>)> = sqlx::query_as(
        "select display_name, billing_address, shipping_address from parties where id = $1 and deleted_at is null limit 1",
    )
    .bind(&contact_id)
    .fetch_optional(db)
    .await
    .map_err(SalesError::from)?;
    let (display_name, billing_raw, shipping_raw) = contact.unwrap_or((None, None, None));
    let billing = normalize_postal_address(billing_raw.as_ref());
    let shipping = normalize_postal_address(shipping_raw.as_ref());
    let tax_address = shipping.clone().or_else(|| billing.clone());

    let invoice_number = next_entity_number(db, &entity_id, SequenceType::Invoice)
        .await
        .map_err(SalesError::from)?
        .formatted;
    let invoice_id = generate_id("inv");
    let item_ids: Vec<String> = items.iter().map(|_| generate_id("ili")).collect();
    let number_text = |value: &Value, fallback: f64| {
        let n = value
            .as_f64()
            .filter(|n| *n != 0.0 && !n.is_nan())
            .unwrap_or(fallback);
        js::number_text(n)
    };
    let lines: Vec<DocumentTaxItem> = items
        .iter()
        .enumerate()
        .map(|(idx, item)| DocumentTaxItem {
            id: Some(item_ids[idx].clone()),
            description: item["description"].as_str().map(str::to_owned),
            quantity: Some(number_text(&item["quantity"], 1.0)),
            unit_price: number_text(&item["unitPrice"], 0.0),
            discount_percent: Some("0".into()),
            tax_rate_id: item["taxRateId"].as_str().map(str::to_owned),
            #[allow(clippy::cast_precision_loss)]
            sort_order: Some(idx as f64),
            product_id: item["productId"].as_str().map(str::to_owned),
            tax_code: item["taxCode"].as_str().map(str::to_owned),
            tax_use: item["taxUse"].as_str().map(str::to_owned),
            tax_included: Some(item["taxIncluded"].as_bool().unwrap_or(false)),
            ncm: item["ncm"].as_str().map(str::to_owned),
            cfop: item["cfop"].as_str().map(str::to_owned),
            fiscal_data: item.get("fiscalData").filter(|f| !f.is_null()).cloned(),
            ..DocumentTaxItem::default()
        })
        .collect();
    let ship_from = normalize_postal_address(template.get("shipFromAddress"));
    let gst = resolve_gst_supply(
        db,
        SupplyArgs {
            entity_id: &entity_id,
            contact_id: Some(&contact_id),
            place_of_supply: None,
            shipping_address: shipping.as_ref(),
            billing_address: billing.as_ref(),
        },
    )
    .await
    .map_err(SalesError::from)?;
    let doc = DocumentContext {
        kind: DocumentKind::Invoice,
        document_id: Some(invoice_id.clone()),
        document_number: Some(invoice_number.clone()),
        contact_id: Some(contact_id.clone()),
        issue_date: IssueDate::Instant(at.clone()),
        currency: Some(currency.clone()),
        billing_address: billing.clone(),
        shipping_address: shipping.clone(),
        delivery_address: None,
        ship_from_address: ship_from.clone(),
        marketplace_facilitated: None,
        fiscal_data: template.get("fiscalData").filter(|f| !f.is_null()).cloned(),
        original_invoice_id: None,
    };
    let rt = runtime(caller, state);
    let country = tax_address
        .as_ref()
        .and_then(|a| a["country"].as_str().map(str::to_owned));
    let province = tax_address
        .as_ref()
        .and_then(|a| a["state"].as_str().map(str::to_owned));
    let mut args = TaxArgs::new(
        &entity_id,
        weldsuite_books_domain::tax::Direction::Sales,
        &lines,
    );
    args.buyer_country = country.as_deref();
    args.billing_province = province.as_deref();
    let mut args = args.with_gst(gst.as_ref());
    args.document = Some(&doc);
    args.runtime = Some(&rt);
    let drafted: Drafted = calculate_draft_tax(db, &args)
        .await
        .map_err(SalesError::from)?;
    let totals = &drafted.calc;
    #[allow(clippy::cast_possible_truncation)]
    let due = js::iso_from_millis(at_ms + (terms * DAY_MS as f64) as i64).unwrap_or_default();

    let or_null = |value: &Value| match value.as_str().filter(|v| !v.is_empty()) {
        Some(v) => json!(v),
        None => Value::Null,
    };
    let mut invoice = Map::new();
    invoice.insert("id".into(), json!(invoice_id));
    invoice.insert("entityId".into(), json!(entity_id));
    invoice.insert("invoiceNumber".into(), json!(invoice_number));
    invoice.insert("type".into(), json!("standard"));
    invoice.insert("status".into(), json!("draft"));
    invoice.insert("contactId".into(), json!(contact_id));
    invoice.insert(
        "contactName".into(),
        json!(display_name.filter(|n| !n.is_empty())),
    );
    invoice.insert("contactEmail".into(), Value::Null);
    invoice.insert("issueDate".into(), json!(at));
    invoice.insert("dueDate".into(), json!(due));
    invoice.insert("currency".into(), json!(currency));
    invoice.extend(invoice_tax_columns(totals));
    if let Some(message) = &drafted.failure {
        invoice.insert(
            "taxWarnings".into(),
            json!([engine_unavailable_warning(message)]),
        );
    }
    invoice.insert("shipFromAddress".into(), json!(ship_from));
    invoice.insert(
        "placeOfSupply".into(),
        json!(gst.as_ref().and_then(|g| g.place_of_supply.clone())),
    );
    invoice.insert(
        "fiscalData".into(),
        template.get("fiscalData").cloned().unwrap_or(Value::Null),
    );
    invoice.insert("amountPaid".into(), json!("0"));
    invoice.insert("balanceDue".into(), json!(totals.balance_due));
    invoice.insert("paymentTermsDays".into(), js::number_value(terms));
    invoice.insert("reference".into(), or_null(&template["reference"]));
    invoice.insert("notes".into(), or_null(&template["notes"]));
    invoice.insert("internalNotes".into(), or_null(&template["internalNotes"]));
    invoice.insert("billingAddress".into(), json!(billing));
    invoice.insert("shippingAddress".into(), json!(shipping));
    invoice.insert(
        "revenueAccountId".into(),
        or_null(&template["revenueAccountId"]),
    );
    invoice.insert("recurringInvoiceId".into(), rec["id"].clone());
    invoice.insert("createdBy".into(), json!(caller.user()));
    invoice.insert("createdAt".into(), json!(at));
    invoice.insert("updatedAt".into(), json!(at));

    let rows: Vec<Map<String, Value>> = items
        .iter()
        .enumerate()
        .map(|(idx, item)| {
            let mut row = Map::new();
            row.insert("id".into(), json!(item_ids[idx]));
            row.insert("entityId".into(), json!(entity_id));
            row.insert("invoiceId".into(), json!(invoice_id));
            row.insert("description".into(), item["description"].clone());
            row.insert("quantity".into(), json!(lines[idx].quantity));
            row.insert("unitPrice".into(), json!(lines[idx].unit_price));
            row.insert("unit".into(), or_null(&item["unit"]));
            row.insert("discountPercent".into(), json!("0"));
            row.extend(item_tax_columns(totals, idx));
            let account = item["accountId"]
                .as_str()
                .filter(|a| !a.is_empty())
                .or_else(|| {
                    template["revenueAccountId"]
                        .as_str()
                        .filter(|a| !a.is_empty())
                });
            row.insert("accountId".into(), json!(account));
            row.insert("productId".into(), or_null(&item["productId"]));
            #[allow(clippy::cast_possible_wrap)]
            row.insert("sortOrder".into(), json!(idx as i64));
            row.insert("taxCode".into(), or_null(&item["taxCode"]));
            row.insert("hsnSac".into(), or_null(&item["hsnSac"]));
            row.insert("ncm".into(), or_null(&item["ncm"]));
            row.insert("cfop".into(), or_null(&item["cfop"]));
            row.insert(
                "fiscalData".into(),
                item.get("fiscalData").cloned().unwrap_or(Value::Null),
            );
            row.insert("taxUse".into(), or_null(&item["taxUse"]));
            row.insert(
                "taxIncluded".into(),
                json!(item["taxIncluded"].as_bool().unwrap_or(false)),
            );
            row.insert("classId".into(), or_null(&item["classId"]));
            row.insert("locationId".into(), or_null(&item["locationId"]));
            row.insert("createdAt".into(), json!(at));
            row.insert("updatedAt".into(), json!(at));
            row
        })
        .collect();
    let count = rec["generatedCount"].as_i64().unwrap_or(0) + 1;
    let mut tx = db.begin().await.map_err(SalesError::from)?;
    INVOICES
        .insert_raw(&mut *tx, INVOICES.values(&invoice))
        .await
        .map_err(SalesError::from)?;
    for row in &rows {
        INVOICE_ITEMS
            .insert_raw(&mut *tx, INVOICE_ITEMS.values(row))
            .await
            .map_err(SalesError::from)?;
    }
    sqlx::query(
        "update recurring_invoices set generated_count = $1, last_generated_at = $2::timestamp, \
         last_generated_invoice_id = $3, updated_at = $2::timestamp where id = $4",
    )
    .bind(count)
    .bind(&at)
    .bind(&invoice_id)
    .bind(text(rec, "id").unwrap_or_default())
    .execute(&mut *tx)
    .await
    .map_err(SalesError::from)?;
    tx.commit().await.map_err(SalesError::from)?;

    // autoFinalizeGenerated
    let (journal_entry_id, finalize_error) = if !rec["autoFinalize"].as_bool().unwrap_or(false) {
        (None, None)
    } else if let Some(message) = &drafted.failure {
        (
            None,
            Some(format!(
                "The sales tax engine could not calculate tax ({message}); the invoice was left as a draft."
            )),
        )
    } else if rows.is_empty() {
        (None, None)
    } else {
        match finalize_invoice(
            db,
            &invoice_id,
            FinalizeOptions {
                user_id: caller.user().map(str::to_owned),
                mark_sent: rec["autoSend"].as_bool().unwrap_or(false),
                runtime: &rt,
                http: rt.http.as_ref(),
            },
        )
        .await
        {
            Ok(finalized) => (finalized.journal_entry_id, None),
            Err(error) => (None, Some(error.message())),
        }
    };
    Ok(Generated {
        invoice_id,
        invoice_number,
        next_issue_date: next_iso,
        status,
        journal_entry_id,
        finalize_error,
    })
}
