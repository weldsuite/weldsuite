//! Processing a bank line (Rust only, edition feature
//! `books-bank-processing`; the TypeScript worker has none of these routes):
//!
//! - `POST /api/bank-transactions/:id/categorize`: book the line to one or
//!   several categories as one journal entry (a split).
//! - `POST /api/bank-transactions/:id/transfer`: a transfer between two own
//!   accounts, against the transfers-in-transit account.
//! - `POST /api/bank-transactions/:id/private`: paid privately.
//! - `POST /api/bank-transactions/:id/attach-document`: the line carries an
//!   inbox document (its receipt); nothing is booked.
//! - `PATCH /api/bank-transactions/:id`: the line's notes.
//! - `POST /api/bank-transactions/:id/undo`: one undo for every kind of
//!   processing.
//!
//! Every booking goes through the posting service (one atomic, idempotent
//! entry); every change is written to the accounting audit log and announced
//! as `bank_transaction.processed` (with `how`) or `.unprocessed`.

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::Response;
use http::HeaderMap;
use sea_orm::sea_query::Expr;
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QuerySelect};
use serde_json::{Map, Value, json};
use weldsuite_books_domain::bank_processing::{book_transfer, undo_line};
use weldsuite_books_domain::bank_split::{Split, SplitLine, book_split};
use weldsuite_books_domain::document_posting::load_entity;
use weldsuite_books_domain::guards::{AuditInput, write_accounting_audit};
use weldsuite_books_domain::http::{BooksState, Caller, Refusal, Reply, now, ok, reply, validate};
use weldsuite_books_domain::js::{js_number_value, round_money};
use weldsuite_books_domain::system_accounts::{ensure_role_account, private_role};
use weldsuite_books_domain::tables::{BANK_TRANSACTIONS, DOCUMENTS};
use weldsuite_catalogs::entity_events::{
    ACCOUNTING_DOCUMENT_UPDATED, BANK_TRANSACTION_PROCESSED, BANK_TRANSACTION_UNPROCESSED,
    BANK_TRANSACTION_UPDATED, BILL_UPDATED, INVOICE_UPDATED, JOURNAL_ENTRY_CREATED,
    JOURNAL_ENTRY_UPDATED, PAYMENT_DELETED,
};
use weldsuite_db::orm;
use weldsuite_kit::validation::{Number, Presence};
use weldsuite_schema::tenant::{documents, parties, payment_allocations};

use crate::bank_transactions::{find_line, line_event};
use crate::common::{changes, field, posting_refusal, text};

/// `line_event` and how the line was processed.
fn processed_event(txn: &Value, status: &str, how: &str) -> Value {
    let mut event = line_event(txn, status);
    event["how"] = json!(how);
    event
}

/// What every booking leaves behind: the audit trail and the events.
#[allow(clippy::too_many_arguments)] // one booking's facts, all of them
async fn record_booked(
    caller: &Caller,
    state: &BooksState,
    txn: &Value,
    how: &str,
    kind: &str,
    journal_entry_id: &str,
    category_account_id: &str,
) {
    let id = text(txn, "id").unwrap_or_default();
    write_accounting_audit(
        caller,
        &caller.db,
        AuditInput {
            accounting_entity_id: text(txn, "entityId"),
            entity_type: "bank_transaction",
            entity_id: id,
            action: "reconciled",
            changes: Some(changes(vec![
                ("status", field(txn, "status"), json!("reconciled")),
                (
                    "reconciliationType",
                    field(txn, "reconciliationType"),
                    json!(kind),
                ),
                (
                    "categoryAccountId",
                    field(txn, "categoryAccountId"),
                    json!(category_account_id),
                ),
                (
                    "journalEntryId",
                    field(txn, "journalEntryId"),
                    json!(journal_entry_id),
                ),
            ])),
        },
    )
    .await;
    caller.publish(
        state,
        BANK_TRANSACTION_UPDATED,
        id,
        line_event(txn, "reconciled"),
    );
    caller.publish(
        state,
        BANK_TRANSACTION_PROCESSED,
        id,
        processed_event(txn, "reconciled", how),
    );
    caller.publish(
        state,
        JOURNAL_ENTRY_CREATED,
        journal_entry_id,
        json!({ "id": journal_entry_id, "sourceType": "bank_transaction", "sourceId": id }),
    );
}

// ── POST /:id/categorize ────────────────────────────────────────────────────

/// `{ lines: [{ accountId, taxRateId?, contactId?, projectId?, amount,
/// description? }] }`; `amount` is tax-inclusive.
pub(crate) fn read_categorize(
    issues: &mut weldsuite_kit::validation::Issues,
    body: &Map<String, Value>,
) -> Vec<SplitLine> {
    let lines = issues.list(
        body,
        "lines",
        Presence::Required,
        Some(1),
        Some(100),
        |issues, item| {
            let fields = issues.object(item)?;
            let mut optional = |key: &str, max: usize| {
                issues
                    .text(fields, key, Presence::Nullish, None, Some(max))
                    .into_option()
                    .filter(|v| !v.is_empty())
            };
            let tax_rate_id = optional("taxRateId", 30);
            let contact_id = optional("contactId", 30);
            let project_id = optional("projectId", 30);
            let description = optional("description", 500);
            let account = issues.text(fields, "accountId", Presence::Required, Some(1), Some(30));
            let amount = issues.number(
                fields,
                "amount",
                Presence::Required,
                Number {
                    coerce: true,
                    ..Number::default()
                },
            );
            Some(SplitLine {
                account_id: account.into_option()?,
                tax_rate_id,
                contact_id,
                project_id,
                amount: amount.into_option()?,
                description,
            })
        },
    );
    lines.into_option().unwrap_or_default()
}

pub(crate) async fn categorize(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let lines = match validate(&headers, &body, read_categorize) {
        Ok(lines) => lines,
        Err(refusal) => return refusal.respond("Failed to categorize the bank line"),
    };
    reply(
        categorize_line(&caller, &state, &id, lines).await,
        "Failed to categorize the bank line",
    )
}

pub(crate) async fn categorize_line(
    caller: &Caller,
    state: &BooksState,
    id: &str,
    lines: Vec<SplitLine>,
) -> Reply {
    let Some(txn) = find_line(caller, id).await? else {
        return Err(Refusal::not_found("Transaction", id));
    };
    let contacts: Vec<&str> = lines
        .iter()
        .filter_map(|line| line.contact_id.as_deref())
        .collect();
    if !contacts.is_empty() {
        let found: Vec<String> = parties::Entity::find()
            .select_only()
            .column(parties::Column::Id)
            .filter(parties::Column::Id.is_in(contacts.iter().copied()))
            .filter(parties::Column::DeletedAt.is_null())
            .into_tuple()
            .all(&orm(&caller.db))
            .await?;
        if let Some(missing) = contacts.iter().find(|c| !found.iter().any(|f| f == *c)) {
            return Err(Refusal::bad_request(format!("Contact {missing} not found")));
        }
    }
    let booked = book_split(
        &caller.db,
        &txn,
        Split {
            lines: &lines,
            kind: "manual",
            user_id: caller.user(),
        },
    )
    .await
    .map_err(posting_refusal)?;
    let category = lines[0].account_id.as_str();
    record_booked(
        caller,
        state,
        &txn,
        "category",
        "manual",
        &booked.journal_entry_id,
        category,
    )
    .await;
    Ok(ok(json!({
        "id": id,
        "status": "reconciled",
        "reconciliationType": "manual",
        "categoryAccountId": category,
        "journalEntryId": booked.journal_entry_id,
        "lines": lines.len(),
    })))
}

// ── POST /:id/transfer ──────────────────────────────────────────────────────

pub(crate) async fn transfer(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    // `{ bankAccountId? }`; no body at all is the same as `{}`.
    let other = if body.is_empty() {
        None
    } else {
        match validate(&headers, &body, |issues, body| {
            issues
                .text(body, "bankAccountId", Presence::Nullish, None, Some(30))
                .into_option()
                .filter(|v| !v.is_empty())
        }) {
            Ok(other) => other,
            Err(refusal) => return refusal.respond("Failed to book the transfer"),
        }
    };
    reply(
        transfer_line(&caller, &state, &id, other).await,
        "Failed to book the transfer",
    )
}

pub(crate) async fn transfer_line(
    caller: &Caller,
    state: &BooksState,
    id: &str,
    other: Option<String>,
) -> Reply {
    let Some(txn) = find_line(caller, id).await? else {
        return Err(Refusal::not_found("Transaction", id));
    };
    let done = book_transfer(
        &caller.db,
        &txn,
        other.as_deref(),
        "transfer",
        caller.user(),
    )
    .await
    .map_err(posting_refusal)?;
    record_booked(
        caller,
        state,
        &txn,
        "transfer",
        "transfer",
        &done.journal_entry_id,
        &done.transit_account_id,
    )
    .await;
    let mut counterpart = Value::Null;
    if let Some(half) = &done.counterpart
        && let Some(line) = find_line(caller, &half.line_id).await?
    {
        record_booked(
            caller,
            state,
            &line,
            "transfer",
            "transfer",
            &half.journal_entry_id,
            &done.transit_account_id,
        )
        .await;
        counterpart = json!({
            "id": half.line_id,
            "bankAccountId": half.bank_account_id,
            "journalEntryId": half.journal_entry_id,
        });
    }
    Ok(ok(json!({
        "id": id,
        "status": "reconciled",
        "reconciliationType": "transfer",
        "categoryAccountId": done.transit_account_id,
        "journalEntryId": done.journal_entry_id,
        "counterpart": counterpart,
    })))
}

// ── POST /:id/private ───────────────────────────────────────────────────────

pub(crate) async fn private(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
) -> Response {
    reply(
        private_line(&caller, &state, &id).await,
        "Failed to book the private payment",
    )
}

pub(crate) async fn private_line(caller: &Caller, state: &BooksState, id: &str) -> Reply {
    let Some(txn) = find_line(caller, id).await? else {
        return Err(Refusal::not_found("Transaction", id));
    };
    let entity_id = text(&txn, "entityId").unwrap_or_default();
    let entity = load_entity(&caller.db, entity_id)
        .await
        .map_err(posting_refusal)?;
    let role = private_role(
        text(&entity, "jurisdictionCode").unwrap_or_default(),
        text(&entity, "entityType"),
    );
    let account = ensure_role_account(&caller.db, entity_id, role)
        .await
        .map_err(posting_refusal)?;
    let account_id = text(&account, "id").unwrap_or_default().to_owned();
    let amount = round_money(js_number_value(txn.get("amount")).abs());
    let booked = book_split(
        &caller.db,
        &txn,
        Split {
            lines: &[SplitLine {
                account_id: account_id.clone(),
                amount,
                ..SplitLine::default()
            }],
            kind: "private",
            user_id: caller.user(),
        },
    )
    .await
    .map_err(posting_refusal)?;
    record_booked(
        caller,
        state,
        &txn,
        "private",
        "private",
        &booked.journal_entry_id,
        &account_id,
    )
    .await;
    Ok(ok(json!({
        "id": id,
        "status": "reconciled",
        "reconciliationType": "private",
        "categoryAccountId": account_id,
        "journalEntryId": booked.journal_entry_id,
    })))
}

// ── POST /:id/attach-document ───────────────────────────────────────────────

pub(crate) async fn attach_document(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let document_id = match validate(&headers, &body, |issues, body| {
        issues
            .text(body, "documentId", Presence::Required, Some(1), Some(30))
            .into_option()
            .unwrap_or_default()
    }) {
        Ok(document_id) => document_id,
        Err(refusal) => return refusal.respond("Failed to attach the document"),
    };
    reply(
        attach(&caller, &state, &id, &document_id).await,
        "Failed to attach the document",
    )
}

pub(crate) async fn attach(
    caller: &Caller,
    state: &BooksState,
    id: &str,
    document_id: &str,
) -> Reply {
    let Some(txn) = find_line(caller, id).await? else {
        return Err(Refusal::not_found("Transaction", id));
    };
    let entity_id = text(&txn, "entityId").unwrap_or_default();
    let Some(document) = DOCUMENTS.find_live(&caller.db, document_id).await? else {
        return Err(Refusal::not_found("Document", document_id));
    };
    // In the line's entity, or with none (an inbox document may have no entity).
    let document_entity = text(&document, "entityId").filter(|e| !e.is_empty());
    if document_entity.is_some_and(|entity| entity != entity_id) {
        return Err(Refusal::not_found("Document", document_id));
    }
    let linked_type = text(&document, "linkedEntityType").filter(|t| !t.is_empty());
    let linked_id = text(&document, "linkedEntityId").filter(|t| !t.is_empty());
    if let Some(kind) = linked_type
        && !(kind == "bank_transaction" && linked_id == Some(id))
    {
        return Err(Refusal::bad_request(format!(
            "This document is already linked to a {}",
            kind.replace('_', " ")
        )));
    }
    documents::Entity::update_many()
        .col_expr(
            documents::Column::LinkedEntityType,
            Expr::value("bank_transaction"),
        )
        .col_expr(documents::Column::LinkedEntityId, Expr::value(id))
        .col_expr(documents::Column::Status, Expr::value("linked"))
        .col_expr(documents::Column::EntityId, Expr::value(entity_id))
        .col_expr(
            documents::Column::UpdatedAt,
            Expr::value(weldsuite_db::utc_now()),
        )
        .filter(documents::Column::Id.eq(document_id))
        .exec(&orm(&caller.db))
        .await?;
    write_accounting_audit(
        caller,
        &caller.db,
        AuditInput {
            accounting_entity_id: Some(entity_id),
            entity_type: "bank_transaction",
            entity_id: id,
            action: "document_attached",
            changes: Some(changes(vec![(
                "documentId",
                Value::Null,
                json!(document_id),
            )])),
        },
    )
    .await;
    caller.publish(
        state,
        ACCOUNTING_DOCUMENT_UPDATED,
        document_id,
        json!({
            "id": document_id,
            "status": "linked",
            "linkedEntityType": "bank_transaction",
            "linkedEntityId": id,
        }),
    );
    caller.publish(
        state,
        BANK_TRANSACTION_UPDATED,
        id,
        line_event(&txn, text(&txn, "status").unwrap_or("unreconciled")),
    );
    // The receipt answers the questions asked about the line (edition feature
    // `books-questions`).
    weldsuite_books_domain::questions::answer_bank_line_questions(caller, state, id).await;
    Ok(ok(json!({
        "id": id,
        "documentId": document_id,
        "linkedEntityType": "bank_transaction",
        "linkedEntityId": id,
        "status": "linked",
    })))
}

// ── PATCH /:id ──────────────────────────────────────────────────────────────

pub(crate) async fn patch_notes(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    // `{ notes }` only; `null` clears them.
    let notes = match validate(&headers, &body, |issues, body| {
        issues.text(body, "notes", Presence::Nullable, None, Some(5000))
    }) {
        Ok(notes) => notes.into_option(),
        Err(refusal) => return refusal.respond("Failed to update the bank line"),
    };
    reply(
        update_notes(&caller, &state, &id, notes).await,
        "Failed to update the bank line",
    )
}

pub(crate) async fn update_notes(
    caller: &Caller,
    state: &BooksState,
    id: &str,
    notes: Option<String>,
) -> Reply {
    let Some(txn) = find_line(caller, id).await? else {
        return Err(Refusal::not_found("Transaction", id));
    };
    let notes = notes.filter(|n| !n.trim().is_empty());
    let mut set = Map::new();
    set.insert("notes".to_owned(), json!(notes));
    set.insert("updatedAt".to_owned(), json!(now()));
    let row = BANK_TRANSACTIONS
        .patch_raw(&caller.db, id, BANK_TRANSACTIONS.values(&set), true)
        .await?;
    let Some(row) = row else {
        return Err(Refusal::not_found("Transaction", id));
    };
    write_accounting_audit(
        caller,
        &caller.db,
        AuditInput {
            accounting_entity_id: text(&txn, "entityId"),
            entity_type: "bank_transaction",
            entity_id: id,
            action: "updated",
            changes: Some(changes(vec![("notes", field(&txn, "notes"), json!(notes))])),
        },
    )
    .await;
    caller.publish(
        state,
        BANK_TRANSACTION_UPDATED,
        id,
        line_event(&row, text(&row, "status").unwrap_or("unreconciled")),
    );
    Ok(ok(row))
}

// ── POST /:id/undo ──────────────────────────────────────────────────────────

pub(crate) async fn undo(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
) -> Response {
    reply(
        undo_processing(&caller, &state, &id).await,
        "Failed to undo the processing",
    )
}

/// The documents a payment settled, to announce their new balances.
async fn documents_of_payment(
    caller: &Caller,
    payment_id: &str,
) -> Result<Vec<(bool, String)>, Refusal> {
    let rows: Vec<(Option<String>, Option<String>)> = payment_allocations::Entity::find()
        .select_only()
        .columns([
            payment_allocations::Column::InvoiceId,
            payment_allocations::Column::BillId,
        ])
        .filter(payment_allocations::Column::PaymentId.eq(payment_id))
        .filter(payment_allocations::Column::DeletedAt.is_null())
        .into_tuple()
        .all(&orm(&caller.db))
        .await?;
    Ok(rows
        .into_iter()
        .filter_map(|(invoice, bill)| match (invoice, bill) {
            (Some(invoice), _) if !invoice.is_empty() => Some((true, invoice)),
            (_, Some(bill)) if !bill.is_empty() => Some((false, bill)),
            _ => None,
        })
        .collect())
}

pub(crate) async fn undo_processing(caller: &Caller, state: &BooksState, id: &str) -> Reply {
    let Some(txn) = find_line(caller, id).await? else {
        return Err(Refusal::not_found("Transaction", id));
    };
    // What a voided payment settled, read before it is gone.
    let settled = match text(&txn, "reconciledPaymentId").filter(|p| !p.is_empty()) {
        Some(payment) if text(&txn, "reconciliationType") != Some("payment_link") => {
            documents_of_payment(caller, payment).await?
        }
        _ => Vec::new(),
    };
    let undone = undo_line(&caller.db, &txn, caller.user().map(str::to_owned))
        .await
        .map_err(posting_refusal)?;
    write_accounting_audit(
        caller,
        &caller.db,
        AuditInput {
            accounting_entity_id: text(&txn, "entityId"),
            entity_type: "bank_transaction",
            entity_id: id,
            action: "unreconciled",
            changes: Some(changes(vec![
                ("status", field(&txn, "status"), json!("unreconciled")),
                (
                    "reconciliationType",
                    field(&txn, "reconciliationType"),
                    Value::Null,
                ),
                (
                    "reconciledPaymentId",
                    field(&txn, "reconciledPaymentId"),
                    Value::Null,
                ),
                ("journalEntryId", field(&txn, "journalEntryId"), Value::Null),
                ("undone", Value::Null, json!(undone.what)),
            ])),
        },
    )
    .await;
    caller.publish(
        state,
        BANK_TRANSACTION_UPDATED,
        id,
        line_event(&txn, "unreconciled"),
    );
    let mut event = line_event(&txn, "unreconciled");
    event["undone"] = json!(undone.what);
    caller.publish(state, BANK_TRANSACTION_UNPROCESSED, id, event);
    if let Some(entry) = &undone.journal_entry_id {
        caller.publish(
            state,
            JOURNAL_ENTRY_UPDATED,
            entry,
            json!({ "id": entry, "status": "reversed" }),
        );
    }
    if let Some(payment) = &undone.payment_voided_id {
        caller.publish(state, PAYMENT_DELETED, payment, json!({ "id": payment }));
        for (invoice, document) in &settled {
            caller.publish(
                state,
                if *invoice {
                    INVOICE_UPDATED
                } else {
                    BILL_UPDATED
                },
                document,
                json!({ "id": document, "paymentId": payment }),
            );
        }
    }
    Ok(ok(undone.to_json(id)))
}
