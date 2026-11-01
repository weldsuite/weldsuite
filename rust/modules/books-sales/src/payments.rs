//! `/api/payments` (`routes/payments/index.ts`): payments received and
//! sent, each settling one or more invoices or bills. Recording posts the
//! payment with the documents' new paid amounts as one posting
//! ([`weldsuite_books_domain::payments`]); deleting voids it (its entry
//! reversed today, the paid amounts restored). Nothing leaves the ledger.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::Response;
use axum::routing::{get, post};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_books_domain::books_row;
use weldsuite_books_domain::entity_context::resolve_entity_id;
use weldsuite_books_domain::guards::{AuditInput, change, write_accounting_audit};
use weldsuite_books_domain::http::{
    BooksState, Caller, Refusal, Reply, created, no_content, now, ok, paged, reply, validate,
};
use weldsuite_books_domain::js::{self, parse_int};
use weldsuite_books_domain::payments::{
    AllocationInput, RecordPaymentInput, record_payment, void_payment,
};
use weldsuite_books_domain::posting::PostError;
use weldsuite_books_domain::tables::{PAYMENT_ALLOCATIONS, PAYMENTS};
use weldsuite_catalogs::entity_events::{PAYMENT_CREATED, PAYMENT_DELETED};
use weldsuite_kit::validation::{Issues, Presence};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::body::read_currency;

pub(crate) fn router<S, Q>(state: BooksState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route("/", get(list).route_layer(need("banking:read")))
        .route("/", post(create).route_layer(need("banking:create")))
        .route("/{id}", get(detail).route_layer(need("banking:read")))
        .route(
            "/{id}",
            axum::routing::delete(remove).route_layer(need("banking:delete")),
        )
        .with_state(state)
}

/// A posting failure as the payment routes answer it.
fn posting_refusal(error: PostError) -> Refusal {
    match error.user_message() {
        Some(message) => Refusal::bad_request(message),
        None => match error {
            PostError::Database(error) => Refusal::Database(error),
            other => Refusal::Internal(other.to_string()),
        },
    }
}

async fn list(caller: Caller) -> Response {
    reply(list_payments(&caller).await, "Failed to fetch payments")
}

async fn list_payments(caller: &Caller) -> Reply {
    let q = caller.query();
    let page = parse_int(q.present("page").unwrap_or("1")).map(|p| p.max(1));
    let page_size = parse_int(q.present("pageSize").unwrap_or("25")).map(|n| n.clamp(1, 100));
    let Some(entity_id) = resolve_entity_id(caller).await? else {
        return Ok(paged(Vec::new(), 0, false, None));
    };
    let (Some(page), Some(page_size)) = (page, page_size) else {
        return Err(Refusal::Internal("page is NaN".to_owned()));
    };
    let check_number = q
        .present("checkNumber")
        .map(|c| weldsuite_books_domain::jurisdictions::js_trim(c).to_owned());
    let deposited = match q.get("deposited") {
        Some("true") => Some(true),
        Some("false") => Some(false),
        _ => None,
    };
    let term = q
        .present("search")
        .map(|s| format!("%{}%", weldsuite_books_domain::jurisdictions::js_trim(s)));
    let from = q
        .present("from")
        .map(|d| js::js_date(d).ok_or_else(|| Refusal::Internal("Invalid time value".into())))
        .transpose()?;
    let to = q
        .present("to")
        .map(|d| js::js_date(d).ok_or_else(|| Refusal::Internal("Invalid time value".into())))
        .transpose()?;
    const WHERE: &str = "t.deleted_at is null and t.entity_id = $1 \
         and ($2::text is null or t.type = $2) and ($3::text is null or t.contact_id = $3) \
         and ($4::text is null or t.check_number = $4) and ($5::text is null or t.payment_method = $5) \
         and ($6::text is null or t.check_status = $6) and ($7::text is null or t.bank_account_id = $7) \
         and ($8::boolean is null or ($8 and t.deposit_id is not null) or (not $8 and t.deposit_id is null)) \
         and ($9::text is null or (t.reference like $9 or t.check_number like $9 or t.notes like $9)) \
         and ($10::timestamp is null or t.date >= $10::timestamp) and ($11::timestamp is null or t.date <= $11::timestamp)";
    let _ = WHERE;
    let rows: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        books_row!(payments),
        " from payments t where t.deleted_at is null and t.entity_id = $1 \
         and ($2::text is null or t.type = $2) and ($3::text is null or t.contact_id = $3) \
         and ($4::text is null or t.check_number = $4) and ($5::text is null or t.payment_method = $5) \
         and ($6::text is null or t.check_status = $6) and ($7::text is null or t.bank_account_id = $7) \
         and ($8::boolean is null or ($8 and t.deposit_id is not null) or (not $8 and t.deposit_id is null)) \
         and ($9::text is null or (t.reference like $9 or t.check_number like $9 or t.notes like $9)) \
         and ($10::timestamp is null or t.date >= $10::timestamp) and ($11::timestamp is null or t.date <= $11::timestamp) \
         order by t.date desc limit $12 offset $13"
    ))
    .bind(&entity_id)
    .bind(q.present("type"))
    .bind(q.present("contactId"))
    .bind(check_number.as_deref())
    .bind(q.present("paymentMethod"))
    .bind(q.present("checkStatus"))
    .bind(q.present("bankAccountId"))
    .bind(deposited)
    .bind(term.as_deref())
    .bind(from.as_deref())
    .bind(to.as_deref())
    .bind(page_size)
    .bind((page - 1) * page_size)
    .fetch_all(&caller.db)
    .await?;
    let total: i32 = sqlx::query_scalar(
        "select count(*)::int from payments t where t.deleted_at is null and t.entity_id = $1 \
         and ($2::text is null or t.type = $2) and ($3::text is null or t.contact_id = $3) \
         and ($4::text is null or t.check_number = $4) and ($5::text is null or t.payment_method = $5) \
         and ($6::text is null or t.check_status = $6) and ($7::text is null or t.bank_account_id = $7) \
         and ($8::boolean is null or ($8 and t.deposit_id is not null) or (not $8 and t.deposit_id is null)) \
         and ($9::text is null or (t.reference like $9 or t.check_number like $9 or t.notes like $9)) \
         and ($10::timestamp is null or t.date >= $10::timestamp) and ($11::timestamp is null or t.date <= $11::timestamp)",
    )
    .bind(&entity_id)
    .bind(q.present("type"))
    .bind(q.present("contactId"))
    .bind(check_number.as_deref())
    .bind(q.present("paymentMethod"))
    .bind(q.present("checkStatus"))
    .bind(q.present("bankAccountId"))
    .bind(deposited)
    .bind(term.as_deref())
    .bind(from.as_deref())
    .bind(to.as_deref())
    .fetch_one(&caller.db)
    .await?;
    let total = i64::from(total);
    Ok(paged(
        PAYMENTS.js_rows(rows),
        total,
        page * page_size < total,
        None,
    ))
}

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    reply(
        async {
            let payment: Option<Value> = sqlx::query_scalar(concat!(
                "select ",
                books_row!(payments),
                " from payments t where t.id = $1 and t.deleted_at is null limit 1"
            ))
            .bind(&id)
            .fetch_optional(&caller.db)
            .await?;
            let Some(payment) = payment.map(|p| PAYMENTS.js(p)) else {
                return Err(Refusal::not_found("Payment", &id));
            };
            let allocations: Vec<Value> = sqlx::query_scalar(concat!(
                "select ",
                books_row!(payment_allocations),
                " from payment_allocations t where t.payment_id = $1 and t.deleted_at is null"
            ))
            .bind(&id)
            .fetch_all(&caller.db)
            .await?;
            let mut out = payment.as_object().cloned().unwrap_or_default();
            out.insert(
                "allocations".into(),
                Value::Array(PAYMENT_ALLOCATIONS.js_rows(allocations)),
            );
            Ok(ok(Value::Object(out)))
        }
        .await,
        "Failed to fetch payment",
    )
}

/// `createPaymentSchema`, as Zod outputs it.
struct CreateInput {
    received: bool,
    amount: String,
    currency: Option<String>,
    date: String,
    payment_method: Option<String>,
    check_number: Option<String>,
    deposit_to: Option<String>,
    reference: Option<String>,
    invoice_id: Option<String>,
    bill_id: Option<String>,
    allocations: Option<Vec<(Option<String>, Option<String>, String)>>,
    contact_id: Option<String>,
    bank_account_id: Option<String>,
    bank_transaction_id: Option<String>,
    notes: Option<String>,
    exchange_rate: Option<String>,
}

fn read_create(issues: &mut Issues, body: &Map<String, Value>) -> Option<CreateInput> {
    let kind = issues.choice(body, "type", Presence::Required, &["received", "sent"]);
    let amount = issues.text(body, "amount", Presence::Required, None, None);
    let currency = read_currency(issues, body);
    let date = issues.text(body, "date", Presence::Required, None, None);
    let method = issues.text(body, "paymentMethod", Presence::Optional, None, Some(30));
    let check = issues.text(body, "checkNumber", Presence::Optional, None, Some(30));
    let deposit = issues.choice(
        body,
        "depositTo",
        Presence::Optional,
        &["undeposited_funds", "bank"],
    );
    let reference = issues.text(body, "reference", Presence::Optional, None, Some(255));
    let invoice_id = issues.text(body, "invoiceId", Presence::Optional, None, None);
    let bill_id = issues.text(body, "billId", Presence::Optional, None, None);
    let allocations = issues.list(
        body,
        "allocations",
        Presence::Optional,
        None,
        None,
        |issues, item| {
            let fields = issues.object(item)?;
            let invoice = issues.text(fields, "invoiceId", Presence::Optional, None, Some(30));
            let bill = issues.text(fields, "billId", Presence::Optional, None, Some(30));
            let amount = issues.text(fields, "amount", Presence::Required, None, None);
            Some((
                invoice.into_option(),
                bill.into_option(),
                amount.into_option()?,
            ))
        },
    );
    let contact = issues.text(body, "contactId", Presence::Optional, Some(1), None);
    let bank = issues.text(body, "bankAccountId", Presence::Optional, None, None);
    let bank_tx = issues.text(body, "bankTransactionId", Presence::Optional, None, None);
    let notes = issues.text(body, "notes", Presence::Optional, None, None);
    let rate = issues.text(body, "exchangeRate", Presence::Optional, None, None);
    Some(CreateInput {
        received: kind.into_option()? == "received",
        amount: amount.into_option()?,
        currency,
        date: date.into_option()?,
        payment_method: method.into_option(),
        check_number: check.into_option(),
        deposit_to: deposit.into_option(),
        reference: reference.into_option(),
        invoice_id: invoice_id.into_option(),
        bill_id: bill_id.into_option(),
        allocations: allocations.into_option(),
        contact_id: contact.into_option(),
        bank_account_id: bank.into_option(),
        bank_transaction_id: bank_tx.into_option(),
        notes: notes.into_option(),
        exchange_rate: rate.into_option(),
    })
}

async fn create(
    caller: Caller,
    State(state): State<BooksState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, read_create) {
        Ok(Some(data)) => data,
        Ok(None) => return Refusal::Internal("body".into()).respond("Failed to create payment"),
        Err(refusal) => return refusal.respond("Failed to create payment"),
    };
    reply(
        create_payment(&caller, &state, data).await,
        "Failed to create payment",
    )
}

async fn create_payment(caller: &Caller, state: &BooksState, data: CreateInput) -> Reply {
    let db = &caller.db;
    let Some(entity_id) = resolve_entity_id(caller).await? else {
        return Err(Refusal::bad_request("No accounting entity resolved"));
    };
    let amount = js::parse_float(&data.amount);
    let allocations: Vec<AllocationInput> = match &data.allocations {
        Some(list) => list
            .iter()
            .map(|(invoice, bill, amount)| AllocationInput {
                invoice_id: invoice.clone(),
                bill_id: bill.clone(),
                amount: js::parse_float(amount),
            })
            .collect(),
        None if data.invoice_id.as_deref().is_some_and(|i| !i.is_empty())
            || data.bill_id.as_deref().is_some_and(|b| !b.is_empty()) =>
        {
            vec![AllocationInput {
                invoice_id: data.invoice_id.clone(),
                bill_id: data.bill_id.clone(),
                amount,
            }]
        }
        None => Vec::new(),
    };
    let date =
        js::js_date(&data.date).ok_or_else(|| Refusal::Internal("Invalid time value".into()))?;
    let http = caller.http(state);
    let result = record_payment(
        db,
        http.as_ref(),
        RecordPaymentInput {
            entity_id: entity_id.clone(),
            received: data.received,
            amount,
            currency: data.currency.clone(),
            exchange_rate: data.exchange_rate.clone(),
            date,
            payment_method: data.payment_method.clone(),
            check_number: data.check_number.clone(),
            deposit_to: data.deposit_to.clone(),
            reference: data.reference.clone(),
            notes: data.notes.clone(),
            contact_id: data.contact_id.clone(),
            bank_account_id: data.bank_account_id.clone(),
            bank_transaction_id: data.bank_transaction_id.clone(),
            allocations,
            user_id: caller.user().map(str::to_owned),
            ..RecordPaymentInput::default()
        },
    )
    .await
    .map_err(posting_refusal)?;
    let mut changes = Map::new();
    changes.insert(
        "journalEntryId".into(),
        change(Value::Null, json!(result.journal_entry_id)),
    );
    write_accounting_audit(
        caller,
        db,
        AuditInput {
            accounting_entity_id: Some(&entity_id),
            entity_type: "payment",
            entity_id: &result.payment_id,
            action: "created",
            changes: Some(changes),
        },
    )
    .await;
    let single = |kind: &str| {
        (result.documents.len() == 1 && result.documents[0].0 == kind)
            .then(|| result.documents[0].1.clone())
    };
    let mut event = Map::new();
    event.insert("id".into(), json!(result.payment_id));
    event.insert("amount".into(), json!(data.amount));
    event.insert("currency".into(), json!(result.currency));
    if let Some(invoice) = single("invoice") {
        event.insert("invoiceId".into(), json!(invoice));
    }
    if let Some(bill) = single("bill") {
        event.insert("billId".into(), json!(bill));
    }
    if let Some(method) = &data.payment_method {
        event.insert("method".into(), json!(method));
    }
    caller.publish(
        state,
        PAYMENT_CREATED,
        &result.payment_id,
        Value::Object(event),
    );
    Ok(created(json!({
        "id": result.payment_id,
        "journalEntryId": result.journal_entry_id,
        "undeposited": result.undeposited,
    })))
}

async fn remove(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
) -> Response {
    reply(
        async {
            let db = &caller.db;
            let payment = match void_payment(db, &id, caller.user().map(str::to_owned), None).await
            {
                Ok(payment) => payment,
                Err(PostError::Posting(message)) if message == "Payment not found" => {
                    return Err(Refusal::not_found("Payment", &id));
                }
                Err(error) => return Err(posting_refusal(error)),
            };
            write_accounting_audit(
                &caller,
                db,
                AuditInput {
                    accounting_entity_id: payment["entityId"].as_str(),
                    entity_type: "payment",
                    entity_id: &id,
                    action: "deleted",
                    changes: None,
                },
            )
            .await;
            let amount = match payment.get("amount") {
                Some(Value::String(a)) if !a.is_empty() => json!(a),
                _ => json!("0"),
            };
            caller.publish(
                &state,
                PAYMENT_DELETED,
                &id,
                json!({
                    "id": id,
                    "amount": amount,
                    "currency": payment["currency"],
                    "invoiceId": payment["invoiceId"],
                    "billId": payment["billId"],
                }),
            );
            let _ = now();
            Ok(no_content())
        }
        .await,
        "Failed to delete payment",
    )
}
