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
use sea_orm::{
    ColumnTrait, Condition, EntityTrait, PaginatorTrait, QueryFilter, QueryOrder, QuerySelect,
};
use serde_json::{Map, Value, json};
use time::PrimitiveDateTime;
use weldsuite_books_domain::entity_context::{records_in_entity, resolve_entity_id};
use weldsuite_books_domain::guards::{AuditInput, change, write_accounting_audit};
use weldsuite_books_domain::http::{
    BooksState, Caller, Refusal, Reply, created, no_content, ok, paged, reply, validate,
};
use weldsuite_books_domain::js::{self, parse_int};
use weldsuite_books_domain::payments::{
    AllocationInput, RecordPaymentInput, record_payment, void_payment,
};
use weldsuite_books_domain::posting::PostError;
use weldsuite_catalogs::entity_events::{PAYMENT_CREATED, PAYMENT_DELETED};
use weldsuite_db::orm;
use weldsuite_kit::ApiError;
use weldsuite_kit::validation::{Issues, Presence};
use weldsuite_legal_entities::{EntityRecordGuard, EntityTable};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::{payment_allocations, payments};

use crate::body::read_currency;
use crate::invoices::{js_timestamp, page_window, row_json};

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
        // A record of an entity the request may not touch answers 404
        // (per-entity access; books-api `guardEntityRecords`).
        .route_layer(EntityRecordGuard::table(EntityTable::new("payments"), "Payment").layer())
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

/// The list's filters (`conditions` of `GET /`).
struct PaymentFilters<'a> {
    entity_id: &'a str,
    kind: Option<&'a str>,
    contact_id: Option<&'a str>,
    check_number: Option<&'a str>,
    payment_method: Option<&'a str>,
    check_status: Option<&'a str>,
    bank_account_id: Option<&'a str>,
    deposited: Option<bool>,
    term: Option<&'a str>,
    from: Option<PrimitiveDateTime>,
    to: Option<PrimitiveDateTime>,
}

impl PaymentFilters<'_> {
    /// The `where` of the page and of its count.
    fn condition(&self) -> Condition {
        let equal = [
            (payments::Column::Type, self.kind),
            (payments::Column::ContactId, self.contact_id),
            (payments::Column::CheckNumber, self.check_number),
            (payments::Column::PaymentMethod, self.payment_method),
            (payments::Column::CheckStatus, self.check_status),
            (payments::Column::BankAccountId, self.bank_account_id),
        ];
        let mut condition = Condition::all()
            .add(payments::Column::DeletedAt.is_null())
            .add(payments::Column::EntityId.eq(self.entity_id));
        for (column, value) in equal {
            if let Some(value) = value {
                condition = condition.add(column.eq(value));
            }
        }
        match self.deposited {
            Some(true) => condition = condition.add(payments::Column::DepositId.is_not_null()),
            Some(false) => condition = condition.add(payments::Column::DepositId.is_null()),
            None => {}
        }
        if let Some(term) = self.term {
            condition = condition.add(
                Condition::any()
                    .add(payments::Column::Reference.like(term))
                    .add(payments::Column::CheckNumber.like(term))
                    .add(payments::Column::Notes.like(term)),
            );
        }
        if let Some(from) = self.from {
            condition = condition.add(payments::Column::Date.gte(from));
        }
        if let Some(to) = self.to {
            condition = condition.add(payments::Column::Date.lte(to));
        }
        condition
    }
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
    let from = q.present("from").map(js_timestamp).transpose()?;
    let to = q.present("to").map(js_timestamp).transpose()?;
    let filters = PaymentFilters {
        entity_id: &entity_id,
        kind: q.present("type"),
        contact_id: q.present("contactId"),
        check_number: check_number.as_deref(),
        payment_method: q.present("paymentMethod"),
        check_status: q.present("checkStatus"),
        bank_account_id: q.present("bankAccountId"),
        deposited,
        term: term.as_deref(),
        from,
        to,
    };
    let (limit, offset) = page_window(page, page_size)?;
    let db = orm(&caller.db);
    let rows = payments::Entity::find()
        .filter(filters.condition())
        .order_by_desc(payments::Column::Date)
        .limit(limit)
        .offset(offset)
        .all(&db)
        .await?;
    let total = payments::Entity::find()
        .filter(filters.condition())
        .count(&db)
        .await?;
    let total = i64::try_from(total).unwrap_or(i64::MAX);
    let rows = rows
        .into_iter()
        .map(row_json)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(paged(rows, total, page * page_size < total, None))
}

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    reply(
        async {
            let db = orm(&caller.db);
            let payment = payments::Entity::find_by_id(id.clone())
                .filter(payments::Column::DeletedAt.is_null())
                .one(&db)
                .await?;
            let Some(payment) = payment.map(row_json).transpose()? else {
                return Err(Refusal::not_found("Payment", &id));
            };
            let allocations = payment_allocations::Entity::find()
                .filter(payment_allocations::Column::PaymentId.eq(id.as_str()))
                .filter(payment_allocations::Column::DeletedAt.is_null())
                .all(&db)
                .await?
                .into_iter()
                .map(row_json)
                .collect::<Result<Vec<_>, _>>()?;
            let mut out = payment.as_object().cloned().unwrap_or_default();
            out.insert("allocations".into(), Value::Array(allocations));
            Ok(ok(Value::Object(out)))
        }
        .await,
        "Failed to fetch payment",
    )
}

/// One of `allocations`: invoice id, bill id, amount.
type Allocation = (Option<String>, Option<String>, String);

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
    allocations: Option<Vec<Allocation>>,
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

/// The documents, bank account and bank line the body names must be in an
/// entity this request may touch (`recordsInEntity` for each table; the
/// invoice and bill tables are each asked for every document id named).
async fn named_records_in_entity(caller: &Caller, data: &CreateInput) -> Result<bool, Refusal> {
    let mut named: Vec<&str> = Vec::new();
    named.extend(data.invoice_id.as_deref());
    named.extend(data.bill_id.as_deref());
    for (invoice, bill, _) in data.allocations.iter().flatten() {
        named.extend(invoice.as_deref());
        named.extend(bill.as_deref());
    }
    let bank_account: Vec<&str> = data.bank_account_id.as_deref().into_iter().collect();
    let bank_line: Vec<&str> = data.bank_transaction_id.as_deref().into_iter().collect();
    Ok(
        records_in_entity(caller, &EntityTable::new("invoices"), &named).await?
            && records_in_entity(caller, &EntityTable::new("bills"), &named).await?
            && records_in_entity(caller, &EntityTable::new("bank_accounts"), &bank_account).await?
            && records_in_entity(caller, &EntityTable::new("bank_transactions"), &bank_line)
                .await?,
    )
}

#[allow(clippy::too_many_lines)] // mirrors the TypeScript route step by step
async fn create_payment(caller: &Caller, state: &BooksState, data: CreateInput) -> Reply {
    let db = &caller.db;
    let Some(entity_id) = resolve_entity_id(caller).await? else {
        return Err(Refusal::bad_request("No accounting entity resolved"));
    };
    if !named_records_in_entity(caller, &data).await? {
        return Err(ApiError::not_found("Record", None).into());
    }
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
    let paid_on =
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
            date: paid_on,
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
            Ok(no_content())
        }
        .await,
        "Failed to delete payment",
    )
}
