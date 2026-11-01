//! `/api/bank-reconciliations` (`routes/bank-reconciliations/index.ts`,
//! `services/accounting-bank-reconciliation-statement.ts`): statement
//! reconciliation on the bank account's ledger lines. The bookkeeper ticks
//! the lines that cleared up to the statement date and finishes at a
//! difference of zero (or posts the difference to an account); finishing
//! stamps the lines and stores a report; an admin can undo the latest one.
//!
//! Signs: a debit to the ledger account is an inflow, a credit an outflow,
//! on a bank and a card alike. A bank's statement balance is what it holds,
//! a card's what is owed, so a card's signs flip.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::Response;
use axum::routing::{delete, get, patch, post};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use sqlx::PgPool;
use weldsuite_books_domain::entity_context::resolve_entity_id;
use weldsuite_books_domain::guards::{AuditInput, PostingLockKind, write_accounting_audit};
use weldsuite_books_domain::http::{
    BooksState, Caller, Refusal, Reply, created, no_content, now, ok, paged, reply, validate,
};
use weldsuite_books_domain::js::{
    days_from_civil, iso_from_millis, js_number_value, number_value, parse_int, round_money,
    to_fixed,
};
use weldsuite_books_domain::posting::{
    AlsoWrite, PostError, PostJournalEntryInput, PostingLine, ReverseArgs, load_entity_accounts,
    post_journal_entry, reverse_journal_entry,
};
use weldsuite_books_domain::tables::BANK_RECONCILIATIONS;
use weldsuite_catalogs::entity_events::{
    BANK_RECONCILIATION_COMPLETED, BANK_RECONCILIATION_CREATED, BANK_RECONCILIATION_DELETED,
    BANK_RECONCILIATION_UNDONE, BANK_RECONCILIATION_UPDATED,
};
use weldsuite_kit::generate_id;
use weldsuite_kit::validation::{Field, Issues, Presence, Text};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::common::{changes, field, text};

const EPSILON: f64 = 0.005;

pub(crate) fn router<S, Q>(state: BooksState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route("/", get(list).route_layer(need("banking:read")))
        .route("/", post(start).route_layer(need("banking:create")))
        .route("/{id}/report", get(report).route_layer(need("banking:read")))
        .route("/{id}", get(detail).route_layer(need("banking:read")))
        .route("/{id}", patch(save).route_layer(need("banking:update")))
        .route("/{id}", delete(discard).route_layer(need("banking:update")))
        .route(
            "/{id}/complete",
            post(complete).route_layer(need("banking:update")),
        )
        .route("/{id}/undo", post(undo).route_layer(need("banking:manage")))
        .with_state(state)
}

/// A failure of the service: the user's (`PostingError`, 400), a conflict
/// with an open reconciliation (409), or a database error.
enum Failure {
    Post(PostError),
    Conflict(String, String),
}

impl From<PostError> for Failure {
    fn from(error: PostError) -> Self {
        Self::Post(error)
    }
}

impl From<sqlx::Error> for Failure {
    fn from(error: sqlx::Error) -> Self {
        Self::Post(PostError::Database(error))
    }
}

fn posting(message: impl Into<String>) -> Failure {
    Failure::Post(PostError::Posting(message.into()))
}

/// `isUserFixable` → 400; anything else the route's 500.
fn user_fixable(failure: Failure) -> Refusal {
    match failure {
        Failure::Conflict(message, existing) => {
            Refusal::conflict_with(message, json!({ "reconciliationId": existing }))
        }
        Failure::Post(error) => crate::common::posting_refusal(error),
    }
}

/// A route without the `isUserFixable` branch: every failure is its 500.
fn internal(failure: Failure) -> Refusal {
    match failure {
        Failure::Post(PostError::Database(error)) => Refusal::Database(error),
        Failure::Post(other) => Refusal::Internal(other.to_string()),
        Failure::Conflict(message, _) => Refusal::Internal(message),
    }
}

// ── Ledger lines ────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
struct LedgerLine {
    id: String,
    journal_entry_id: String,
    entry_number: Option<String>,
    date: String,
    description: Option<String>,
    debit: f64,
    credit: f64,
    contact_id: Option<String>,
    contact_name: Option<String>,
    reference: Option<String>,
    source_type: Option<String>,
    source_id: Option<String>,
    reversed_by_id: Option<String>,
}

impl LedgerLine {
    fn inflow(&self) -> bool {
        self.debit - self.credit > 0.0
    }
}

/// `dayAfter(statementDate)` as `toISOString()`.
fn day_after(statement_date: &str) -> String {
    let parts: Vec<i64> = statement_date
        .get(..10)
        .unwrap_or_default()
        .split('-')
        .map(|p| p.parse().unwrap_or(0))
        .collect();
    let days = days_from_civil(parts[0], parts.get(1).copied().unwrap_or(1), 1)
        + parts.get(2).copied().unwrap_or(1);
    iso_from_millis(days * 86_400_000).unwrap_or_default()
}

/// `loadLines` with the open (`open`), cleared (`cleared`) or later
/// (`later`) condition.
async fn load_lines(db: &PgPool, rec: &Value, mode: &str) -> Result<Vec<LedgerLine>, sqlx::Error> {
    type Row = (
        String,
        String,
        Option<String>,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
    );
    let rows: Vec<Row> = sqlx::query_as(
        "select jl.id, jl.journal_entry_id, je.entry_number, to_jsonb(je.date) #>> '{}', jl.description, \
         je.description, jl.debit::text, jl.credit::text, jl.contact_id, p.display_name, je.reference, \
         je.source_type, je.source_id, je.reversed_by_id \
         from journal_lines jl inner join journal_entries je on jl.journal_entry_id = je.id \
         left join parties p on p.id = jl.contact_id \
         where jl.account_id = $1 and jl.entity_id = $2 and jl.deleted_at is null and je.deleted_at is null \
         and je.status = any(array['posted','reversed']) \
         and (($3 = 'open' and jl.reconciliation_id is null and je.date < $4::timestamp) \
           or ($3 = 'later' and jl.reconciliation_id is null and je.date >= $4::timestamp) \
           or ($3 = 'cleared' and jl.reconciliation_id = $5)) \
         order by je.date, je.created_at, jl.sort_order",
    )
    .bind(text(rec, "ledgerAccountId"))
    .bind(text(rec, "entityId"))
    .bind(mode)
    .bind(day_after(text(rec, "statementDate").unwrap_or_default()))
    .bind(text(rec, "id"))
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| {
            let number = |v: Option<String>| v.map_or(0.0, |text| weldsuite_kit::validation::js_number(&text));
            LedgerLine {
                id: r.0,
                journal_entry_id: r.1,
                entry_number: r.2,
                date: weldsuite_db::js_timestamp(&r.3).unwrap_or(r.3).chars().take(10).collect(),
                description: r.4.or(r.5),
                debit: number(r.6),
                credit: number(r.7),
                contact_id: r.8,
                contact_name: r.9,
                reference: r.10,
                source_type: r.11,
                source_id: r.12,
                reversed_by_id: r.13,
            }
        })
        .collect())
}

/// `splitNettedPairs`: an entry and its reversal that net to zero, both open
/// and in range, are set aside (and cleared with the reconciliation).
fn split_netted(lines: Vec<LedgerLine>) -> (Vec<LedgerLine>, Vec<LedgerLine>) {
    let mut entries: Vec<(String, Vec<&LedgerLine>)> = Vec::new();
    for line in &lines {
        match entries.iter_mut().find(|(id, _)| *id == line.journal_entry_id) {
            Some((_, group)) => group.push(line),
            None => entries.push((line.journal_entry_id.clone(), vec![line])),
        }
    }
    let sum = |group: &[&LedgerLine]| round_money(group.iter().fold(0.0, |t, l| t + l.debit - l.credit));
    let mut netted: Vec<String> = Vec::new();
    for (entry, group) in &entries {
        let Some(reversed_by) = group[0].reversed_by_id.as_deref().filter(|r| !r.is_empty()) else {
            continue;
        };
        let Some((_, reversal)) = entries.iter().find(|(id, _)| id == reversed_by) else {
            continue;
        };
        if (sum(group) + sum(reversal)).abs() < EPSILON {
            netted.push(entry.clone());
            netted.push(reversed_by.to_owned());
        }
    }
    lines
        .into_iter()
        .partition(|l| !netted.contains(&l.journal_entry_id))
}

/// `LineDocument`, keyed `type:id`.
type Documents = Vec<(String, Value)>;

/// A payment's id, type, reference, check number and method.
type PaymentDocument = (String, Option<String>, Option<String>, Option<String>, Option<String>);

async fn load_documents(db: &PgPool, lines: &[&LedgerLine]) -> Result<Documents, sqlx::Error> {
    let ids_of = |kind: &str| -> Vec<String> {
        let mut ids: Vec<String> = Vec::new();
        for line in lines {
            if line.source_type.as_deref() == Some(kind)
                && let Some(id) = line.source_id.as_deref().filter(|i| !i.is_empty())
                && !ids.iter().any(|i| i == id)
            {
                ids.push(id.to_owned());
            }
        }
        ids
    };
    let mut documents: Documents = Vec::new();
    let payments = ids_of("payment");
    if !payments.is_empty() {
        let rows: Vec<PaymentDocument> = sqlx::query_as(
            "select id, type, reference, check_number, payment_method from payments where id = any($1)",
        )
        .bind(&payments)
        .fetch_all(db)
        .await?;
        for (id, kind, reference, check, method) in rows {
            let kind = if kind.as_deref() == Some("received") { "payment_received" } else { "payment_sent" };
            documents.push((
                format!("payment:{id}"),
                json!({ "type": kind, "id": id, "number": reference, "checkNumber": check, "method": method }),
            ));
        }
    }
    let deposits = ids_of("bank_deposit");
    if !deposits.is_empty() {
        let rows: Vec<(String, Option<String>)> = sqlx::query_as("select id, memo from bank_deposits where id = any($1)")
            .bind(&deposits)
            .fetch_all(db)
            .await?;
        for (id, memo) in rows {
            documents.push((
                format!("bank_deposit:{id}"),
                json!({ "type": "bank_deposit", "id": id, "number": memo, "checkNumber": null, "method": null }),
            ));
        }
    }
    for (kind, sql) in [
        ("invoice", "select id, invoice_number from invoices where id = any($1)"),
        ("bill", "select id, bill_number from bills where id = any($1)"),
    ] {
        let ids = ids_of(kind);
        if ids.is_empty() {
            continue;
        }
        let rows: Vec<(String, Option<String>)> = sqlx::query_as(sql).bind(&ids).fetch_all(db).await?;
        for (id, number) in rows {
            documents.push((
                format!("{kind}:{id}"),
                json!({ "type": kind, "id": id, "number": number, "checkNumber": null, "method": null }),
            ));
        }
    }
    Ok(documents)
}

fn document_of(line: &LedgerLine, documents: &Documents) -> Value {
    match (line.source_type.as_deref(), line.source_id.as_deref()) {
        (Some(kind), Some(id)) if !kind.is_empty() && !id.is_empty() => {
            let key = format!("{kind}:{id}");
            documents
                .iter()
                .find(|(k, _)| *k == key)
                .map_or_else(
                    || json!({ "type": kind, "id": id, "number": null, "checkNumber": null, "method": null }),
                    |(_, doc)| doc.clone(),
                )
        }
        _ => Value::Null,
    }
}

fn line_amount(line: &LedgerLine) -> f64 {
    let inflow = line.debit > 0.0;
    round_money(if inflow { line.debit - line.credit } else { line.credit - line.debit })
}

/// `toView(line, documents, cleared)`.
fn view(line: &LedgerLine, documents: &Documents, cleared: bool) -> Value {
    json!({
        "id": line.id,
        "journalEntryId": line.journal_entry_id,
        "entryNumber": line.entry_number,
        "date": line.date,
        "description": line.description,
        "amount": number_value(line_amount(line)),
        "contactId": line.contact_id,
        "contactName": line.contact_name,
        "reference": line.reference,
        "sourceType": line.source_type,
        "document": document_of(line, documents),
        "cleared": cleared,
    })
}

// ── Balances ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy)]
struct Totals {
    count: usize,
    total: f64,
}

impl Totals {
    fn of(lines: &[&LedgerLine]) -> Self {
        Self {
            count: lines.len(),
            total: round_money(lines.iter().fold(0.0, |t, l| t + (l.debit - l.credit).abs())),
        }
    }

    fn json(self) -> Value {
        json!({ "count": self.count, "total": number_value(self.total) })
    }
}

struct Balances {
    beginning: f64,
    ending: f64,
    cleared: f64,
    difference: f64,
    inflows: Totals,
    outflows: Totals,
}

/// `computeBalances(rec, ticked, liability)`.
fn balances(rec: &Value, ticked: &[&LedgerLine], liability: bool) -> Balances {
    let beginning = js_number_value(rec.get("beginningBalance"));
    let ending = js_number_value(rec.get("statementEndingBalance"));
    let ins: Vec<&LedgerLine> = ticked.iter().copied().filter(|l| l.inflow()).collect();
    let outs: Vec<&LedgerLine> = ticked.iter().copied().filter(|l| !l.inflow()).collect();
    let inflows = Totals::of(&ins);
    let outflows = Totals::of(&outs);
    let sign = if liability { -1.0 } else { 1.0 };
    let cleared = round_money(beginning + sign * (inflows.total - outflows.total));
    Balances {
        beginning,
        ending,
        cleared,
        difference: round_money(ending - cleared),
        inflows,
        outflows,
    }
}

/// `loadLedger(db, entityId, ledgerAccountId)`.
async fn load_ledger(db: &PgPool, rec: &Value) -> Result<Value, Failure> {
    let accounts = load_entity_accounts(db, text(rec, "entityId").unwrap_or_default()).await?;
    accounts
        .by_id(text(rec, "ledgerAccountId"))
        .cloned()
        .ok_or_else(|| posting("The ledger account of this bank account was not found"))
}

async fn bank_account_name(db: &PgPool, rec: &Value) -> Result<Option<String>, sqlx::Error> {
    let name: Option<String> = sqlx::query_scalar("select name from bank_accounts where id = $1 limit 1")
        .bind(text(rec, "bankAccountId"))
        .fetch_optional(db)
        .await?;
    Ok(name)
}

fn cleared_ids(rec: &Value) -> Vec<String> {
    rec.get("clearedLineIds")
        .and_then(Value::as_array)
        .map(|ids| ids.iter().filter_map(Value::as_str).map(str::to_owned).collect())
        .unwrap_or_default()
}

/// `getReconciliationView(db, rec)`: the open lines up to the statement
/// date (or the cleared ones), what is ticked, cleared balance, difference.
async fn reconciliation_view(db: &PgPool, rec: &Value) -> Result<Value, Failure> {
    let ledger = load_ledger(db, rec).await?;
    let liability = text(&ledger, "type") == Some("liability");
    let bank_name = bank_account_name(db, rec).await?;
    let status = text(rec, "status").unwrap_or_default();
    let in_progress = status == "in_progress";
    let completed = status == "completed";
    let raw = if completed {
        load_lines(db, rec, "cleared").await?
    } else if in_progress {
        load_lines(db, rec, "open").await?
    } else {
        Vec::new()
    };
    let (open, netted) = if in_progress { split_netted(raw) } else { (raw, Vec::new()) };
    let refs: Vec<&LedgerLine> = open.iter().collect();
    let documents = load_documents(db, &refs).await?;
    let saved = cleared_ids(rec);
    let ticked_of = |line: &LedgerLine| completed || saved.contains(&line.id);
    let ticked: Vec<&LedgerLine> = open.iter().filter(|l| ticked_of(l)).collect();
    let b = balances(rec, &ticked, liability);
    let mut inflows = Vec::new();
    let mut outflows = Vec::new();
    for line in &open {
        let v = view(line, &documents, ticked_of(line));
        if line.inflow() {
            inflows.push(v);
        } else {
            outflows.push(v);
        }
    }
    let part = |list: &[Value]| {
        let sum = |items: &mut dyn Iterator<Item = &Value>| {
            round_money(items.fold(0.0, |t, v| t + v["amount"].as_f64().unwrap_or(0.0)))
        };
        let cleared: Vec<&Value> = list.iter().filter(|v| v["cleared"] == json!(true)).collect();
        json!({
            "count": list.len(),
            "total": number_value(sum(&mut list.iter())),
            "clearedCount": cleared.len(),
            "clearedTotal": number_value(sum(&mut cleared.into_iter())),
        })
    };
    let totals = json!({ "inflows": part(&inflows), "outflows": part(&outflows) });
    let cleared_balance = if completed { js_number_value(rec.get("clearedBalance").filter(|v| !v.is_null())) } else { b.cleared };
    let difference = if completed { js_number_value(rec.get("difference").filter(|v| !v.is_null())) } else { b.difference };
    let mut out = Map::new();
    out.insert("id".to_owned(), field(rec, "id"));
    out.insert("bankAccountId".to_owned(), field(rec, "bankAccountId"));
    out.insert("bankAccountName".to_owned(), json!(bank_name));
    out.insert("ledgerAccountId".to_owned(), field(rec, "ledgerAccountId"));
    out.insert(
        "ledger".to_owned(),
        json!({ "code": field(&ledger, "code"), "name": field(&ledger, "name"), "type": field(&ledger, "type") }),
    );
    out.insert("accountKind".to_owned(), json!(if liability { "credit_card" } else { "bank" }));
    out.insert("status".to_owned(), json!(status));
    out.insert("statementDate".to_owned(), field(rec, "statementDate"));
    out.insert("beginningBalance".to_owned(), json!(to_fixed(b.beginning, 2)));
    out.insert("statementEndingBalance".to_owned(), json!(to_fixed(b.ending, 2)));
    out.insert("clearedBalance".to_owned(), json!(to_fixed(cleared_balance, 2)));
    out.insert("difference".to_owned(), json!(to_fixed(difference, 2)));
    out.insert(
        "clearedLineIds".to_owned(),
        json!(ticked.iter().map(|l| l.id.clone()).collect::<Vec<_>>()),
    );
    out.insert("inflows".to_owned(), Value::Array(inflows));
    out.insert("outflows".to_owned(), Value::Array(outflows));
    out.insert("totals".to_owned(), totals);
    out.insert("nettedLineCount".to_owned(), json!(netted.len()));
    // Keys the started (not yet re-read) reconciliation leaves undefined.
    for key in ["adjustmentJournalEntryId", "completedAt", "completedBy", "undoneAt", "undoneBy"] {
        if let Some(value) = rec.get(key) {
            out.insert(key.to_owned(), value.clone());
        }
    }
    Ok(Value::Object(out))
}

// ── The report ──────────────────────────────────────────────────────────────

fn snapshot(line: &LedgerLine, documents: &Documents) -> Value {
    let document = document_of(line, documents);
    json!({
        "id": line.id,
        "date": line.date,
        "entryNumber": line.entry_number,
        "description": line.description,
        "amount": number_value(line_amount(line)),
        "contactName": line.contact_name,
        "checkNumber": document.get("checkNumber").cloned().unwrap_or(Value::Null),
        "documentType": document.get("type").cloned().unwrap_or(Value::Null),
        "documentNumber": document.get("number").cloned().unwrap_or(Value::Null),
    })
}

fn group(lines: &[&LedgerLine], documents: &Documents) -> Value {
    let totals = Totals::of(lines);
    json!({
        "count": totals.count,
        "total": number_value(totals.total),
        "items": lines.iter().map(|l| snapshot(l, documents)).collect::<Vec<_>>(),
    })
}

/// The lines of one direction.
fn pick<'a>(lines: &[&'a LedgerLine], inflow: bool) -> Vec<&'a LedgerLine> {
    lines.iter().copied().filter(|l| l.inflow() == inflow).collect()
}

/// `buildReport(db, rec, { ledger, bankAccountName, ticked, uncleared,
/// adjustment })`.
async fn build_report(
    db: &PgPool,
    rec: &Value,
    ledger: &Value,
    bank_name: Option<&str>,
    ticked: &[&LedgerLine],
    uncleared: &[&LedgerLine],
    adjustment: Option<&Value>,
) -> Result<Value, sqlx::Error> {
    let liability = text(ledger, "type") == Some("liability");
    let (later, _) = split_netted(load_lines(db, rec, "later").await?);
    let all: Vec<&LedgerLine> = ticked.iter().chain(uncleared).copied().chain(later.iter()).collect();
    let documents = load_documents(db, &all).await?;
    let b = balances(rec, ticked, liability);
    let sign = if liability { -1.0 } else { 1.0 };
    let later_refs: Vec<&LedgerLine> = later.iter().collect();
    let (uncleared_in, uncleared_out) = (pick(uncleared, true), pick(uncleared, false));
    let (later_in, later_out) = (pick(&later_refs, true), pick(&later_refs, false));
    let register_at_statement = round_money(
        b.cleared + sign * (Totals::of(&uncleared_in).total - Totals::of(&uncleared_out).total),
    );
    let register_now = round_money(
        register_at_statement + sign * (Totals::of(&later_in).total - Totals::of(&later_out).total),
    );
    Ok(json!({
        "version": 1,
        "bankAccountId": field(rec, "bankAccountId"),
        "bankAccountName": bank_name,
        "ledgerAccount": { "id": field(ledger, "id"), "code": field(ledger, "code"), "name": field(ledger, "name") },
        "accountKind": if liability { "credit_card" } else { "bank" },
        "statementDate": field(rec, "statementDate"),
        "summary": {
            "beginningBalance": number_value(b.beginning),
            "clearedInflows": b.inflows.json(),
            "clearedOutflows": b.outflows.json(),
            "clearedBalance": number_value(b.cleared),
            "statementEndingBalance": number_value(b.ending),
            "difference": number_value(b.difference),
            "unclearedInflows": Totals::of(&uncleared_in).json(),
            "unclearedOutflows": Totals::of(&uncleared_out).json(),
            "registerBalanceAtStatementDate": number_value(register_at_statement),
            "unclearedAfterStatementInflows": Totals::of(&later_in).json(),
            "unclearedAfterStatementOutflows": Totals::of(&later_out).json(),
            "registerBalanceToday": number_value(register_now),
        },
        "clearedInflows": group(&pick(ticked, true), &documents),
        "clearedOutflows": group(&pick(ticked, false), &documents),
        "unclearedInflows": group(&uncleared_in, &documents),
        "unclearedOutflows": group(&uncleared_out, &documents),
        "unclearedAfterStatementInflows": group(&later_in, &documents),
        "unclearedAfterStatementOutflows": group(&later_out, &documents),
        "adjustment": adjustment.cloned().unwrap_or(Value::Null),
    }))
}

/// `getReport(db, rec)`: the stored snapshot once completed, a live
/// preview while open.
async fn get_report(db: &PgPool, rec: &Value) -> Result<Value, Failure> {
    if let Some(Value::Object(stored)) = rec.get("report")
        && !stored.is_empty()
    {
        let mut out = Map::new();
        out.insert("status".to_owned(), field(rec, "status"));
        out.extend(stored.clone());
        return Ok(Value::Object(out));
    }
    if text(rec, "status") != Some("in_progress") {
        return Err(posting("This reconciliation has no report"));
    }
    let ledger = load_ledger(db, rec).await?;
    let (open, _) = split_netted(load_lines(db, rec, "open").await?);
    let saved = cleared_ids(rec);
    let bank_name = bank_account_name(db, rec).await?;
    let ticked: Vec<&LedgerLine> = open.iter().filter(|l| saved.contains(&l.id)).collect();
    let uncleared: Vec<&LedgerLine> = open.iter().filter(|l| !saved.contains(&l.id)).collect();
    let report = build_report(db, rec, &ledger, bank_name.as_deref(), &ticked, &uncleared, None).await?;
    let mut out = Map::new();
    out.insert("status".to_owned(), field(rec, "status"));
    out.insert("preview".to_owned(), json!(true));
    if let Value::Object(report) = report {
        out.extend(report);
    }
    Ok(Value::Object(out))
}

// ── Reading ─────────────────────────────────────────────────────────────────

async fn reload(db: &PgPool, id: &str) -> Result<Value, sqlx::Error> {
    let row: Value = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(bank_reconciliations),
        " from bank_reconciliations t where t.id = $1 limit 1"
    ))
    .bind(id)
    .fetch_one(db)
    .await?;
    Ok(BANK_RECONCILIATIONS.js(row))
}

/// `findReconciliation(c, id)`: the resolved entity's reconciliation.
async fn find(caller: &Caller, id: &str) -> Result<Value, Refusal> {
    let Some(entity_id) = resolve_entity_id(caller).await? else {
        return Err(Refusal::bad_request("No accounting entity resolved"));
    };
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(bank_reconciliations),
        " from bank_reconciliations t where t.id = $1 and t.entity_id = $2 limit 1"
    ))
    .bind(id)
    .bind(&entity_id)
    .fetch_optional(&caller.db)
    .await?;
    row.map(|row| BANK_RECONCILIATIONS.js(row))
        .ok_or_else(|| Refusal::not_found("Reconciliation", id))
}

fn event_data(rec: &Value) -> Value {
    json!({
        "id": field(rec, "id"),
        "bankAccountId": field(rec, "bankAccountId"),
        "statementDate": field(rec, "statementDate"),
        "statementEndingBalance": field(rec, "statementEndingBalance"),
        "status": field(rec, "status"),
    })
}

async fn list(caller: Caller) -> Response {
    let result = async {
        let q = caller.query();
        let page = parse_int(q.present("page").unwrap_or("1")).filter(|n| *n != 0).unwrap_or(1).max(1);
        let size = parse_int(q.present("pageSize").unwrap_or("25")).filter(|n| *n != 0).unwrap_or(25).clamp(1, 100);
        let Some(entity_id) = resolve_entity_id(&caller).await? else {
            return Ok(paged(Vec::new(), 0, false, None));
        };
        let account = q.present("bankAccountId");
        let status = q.present("status");
        let rows: Vec<Value> = sqlx::query_scalar(concat!(
            "select ",
            weldsuite_books_domain::books_row!(bank_reconciliations),
            " from bank_reconciliations t where t.entity_id = $1 and ($2::text is null or t.bank_account_id = $2) \
             and ($3::text is null or t.status = $3) order by t.statement_date desc, t.created_at desc limit $4 offset $5"
        ))
        .bind(&entity_id)
        .bind(account)
        .bind(status)
        .bind(size)
        .bind((page - 1) * size)
        .fetch_all(&caller.db)
        .await?;
        let total: i64 = sqlx::query_scalar(
            "select count(*)::int8 from bank_reconciliations t where t.entity_id = $1 \
             and ($2::text is null or t.bank_account_id = $2) and ($3::text is null or t.status = $3)",
        )
        .bind(&entity_id)
        .bind(account)
        .bind(status)
        .fetch_one(&caller.db)
        .await?;
        let slim = BANK_RECONCILIATIONS
            .js_rows(rows)
            .into_iter()
            .map(|row| {
                let mut row = row.as_object().cloned().unwrap_or_default();
                let report = row.remove("report");
                row.insert(
                    "hasReport".to_owned(),
                    json!(report.is_some_and(|r| !r.is_null())),
                );
                Value::Object(row)
            })
            .collect();
        Ok(paged(slim, total, page * size < total, None))
    }
    .await;
    reply(result, "Failed to fetch reconciliations")
}

// ── Bodies ──────────────────────────────────────────────────────────────────

/// `/^\d{4}-\d{2}-\d{2}$/`
fn is_day(value: &str) -> bool {
    let b = value.as_bytes();
    b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && [0, 1, 2, 3, 5, 6, 8, 9].iter().all(|i| b[*i].is_ascii_digit())
}

/// `/^-?\d+(\.\d{1,2})?$/`
fn is_amount(value: &str) -> bool {
    let body = value.strip_prefix('-').unwrap_or(value);
    let (whole, fraction) = body.split_once('.').map_or((body, None), |(w, f)| (w, Some(f)));
    !whole.is_empty()
        && whole.bytes().all(|b| b.is_ascii_digit())
        && fraction.is_none_or(|f| (1..=2).contains(&f.len()) && f.bytes().all(|b| b.is_ascii_digit()))
}

/// `money`: a finite number, or an amount string (`.transform(Number)`).
/// The union settles after the synchronous checks: its issues are returned
/// for the end of the body.
fn money(issues: &mut Issues, body: &Map<String, Value>, key: &str, presence: Presence, late: &mut Vec<Value>) -> Option<f64> {
    match body.get(key) {
        None if presence == Presence::Optional => None,
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::String(s)) if is_amount(s) => Some(weldsuite_kit::validation::js_number(s)),
        Some(Value::String(_)) => {
            late.push(json!({
                "validation": "regex",
                "code": "invalid_string",
                "message": "Use an amount such as 1234.56",
                "path": issues.path_of(key),
            }));
            None
        }
        other => {
            late.push(weldsuite_kit::validation::string_or_number_issue(&issues.path_of(key), other).pipe_number_first());
            None
        }
    }
}

trait NumberFirst {
    fn pipe_number_first(self) -> Value;
}

impl NumberFirst for Value {
    /// The union's options are `[number, string]`: its `unionErrors` list
    /// the number option first.
    fn pipe_number_first(mut self) -> Value {
        if let Some(Value::Array(errors)) = self.get_mut("unionErrors") {
            errors.reverse();
        }
        self
    }
}

fn day(issues: &mut Issues, body: &Map<String, Value>, key: &str, presence: Presence) -> Field<String> {
    issues.pattern(body, key, presence, None, None, is_day, "Use a YYYY-MM-DD date")
}

fn line_ids(issues: &mut Issues, body: &Map<String, Value>) -> Field<Vec<String>> {
    issues.list(body, "clearedLineIds", Presence::Optional, None, Some(20_000), |issues, item| {
        issues.item_text(item, Text::length(Some(1), Some(30)))
    })
}

fn settle(issues: &mut Issues, late: Vec<Value>) {
    for issue in late {
        issues.push_raw(issue);
    }
}

// ── POST / ──────────────────────────────────────────────────────────────────

struct StartBody {
    bank_account_id: String,
    statement_date: String,
    ending: f64,
    beginning: Option<f64>,
}

async fn start(caller: Caller, State(state): State<BooksState>, headers: HeaderMap, body: Bytes) -> Response {
    let data = match validate(&headers, &body, |issues, body| {
        let mut late = Vec::new();
        let account = issues.text(body, "bankAccountId", Presence::Required, Some(1), Some(30));
        let date = day(issues, body, "statementDate", Presence::Required);
        let ending = money(issues, body, "statementEndingBalance", Presence::Required, &mut late);
        let beginning = money(issues, body, "beginningBalance", Presence::Optional, &mut late);
        settle(issues, late);
        Some(StartBody {
            bank_account_id: account.into_option()?,
            statement_date: date.into_option()?,
            ending: ending?,
            beginning,
        })
    }) {
        Ok(Some(data)) => data,
        Ok(None) => return Refusal::Internal("unread body".to_owned()).respond("Failed to start the reconciliation"),
        Err(refusal) => return refusal.respond("Failed to start the reconciliation"),
    };
    let result = async {
        let Some(entity_id) = resolve_entity_id(&caller).await? else {
            return Err(Refusal::bad_request("No accounting entity resolved"));
        };
        let rec = start_reconciliation(&caller.db, &entity_id, &data)
            .await
            .map_err(user_fixable)?;
        write_accounting_audit(
            &caller,
            &caller.db,
            AuditInput {
                accounting_entity_id: Some(&entity_id),
                entity_type: "bank_reconciliation",
                entity_id: text(&rec, "id").unwrap_or_default(),
                action: "created",
                changes: Some(changes(vec![
                    ("bankAccountId", Value::Null, field(&rec, "bankAccountId")),
                    ("statementDate", Value::Null, field(&rec, "statementDate")),
                    ("statementEndingBalance", Value::Null, field(&rec, "statementEndingBalance")),
                ])),
            },
        )
        .await;
        caller.publish(&state, BANK_RECONCILIATION_CREATED, text(&rec, "id").unwrap_or_default(), event_data(&rec));
        let view = reconciliation_view(&caller.db, &rec).await.map_err(user_fixable)?;
        Ok(created(view))
    }
    .await;
    reply(result, "Failed to start the reconciliation")
}

/// `startReconciliation(db, args)`: the row written (as the route's object:
/// no adjustment or completion keys yet).
async fn start_reconciliation(db: &PgPool, entity_id: &str, data: &StartBody) -> Result<Value, Failure> {
    let bank: Option<(String, Option<String>)> = sqlx::query_as(
        "select id, ledger_account_id from bank_accounts where id = $1 and entity_id = $2 and deleted_at is null limit 1",
    )
    .bind(&data.bank_account_id)
    .bind(entity_id)
    .fetch_optional(db)
    .await?;
    let Some((bank_id, ledger_id)) = bank else {
        return Err(posting("Bank account not found for this accounting entity"));
    };
    let Some(ledger_id) = ledger_id.filter(|l| !l.is_empty()) else {
        return Err(posting(
            "This bank account is not linked to a ledger account. Edit the bank account and choose a GL account first.",
        ));
    };
    load_ledger(db, &json!({ "entityId": entity_id, "ledgerAccountId": ledger_id })).await?;
    let open: Option<String> = sqlx::query_scalar(
        "select id from bank_reconciliations where bank_account_id = $1 and status = 'in_progress' limit 1",
    )
    .bind(&bank_id)
    .fetch_optional(db)
    .await?;
    if let Some(open) = open {
        return Err(Failure::Conflict(
            "A reconciliation is already in progress for this account. Finish or discard it first.".to_owned(),
            open,
        ));
    }
    let last: Option<(String, Option<String>)> = sqlx::query_as(
        "select statement_date::text, statement_ending_balance::text from bank_reconciliations \
         where bank_account_id = $1 and status = 'completed' order by statement_date desc, completed_at desc limit 1",
    )
    .bind(&bank_id)
    .fetch_optional(db)
    .await?;
    if let Some((last_date, _)) = &last
        && data.statement_date.as_str() <= last_date.as_str()
    {
        return Err(posting(format!(
            "The statement date must be after the last reconciled statement ({last_date})."
        )));
    }
    let beginning = match &last {
        Some((_, ending)) => js_number_value(ending.clone().map(Value::String).as_ref()),
        None => data.beginning.unwrap_or(0.0),
    };
    let stamp = now();
    let mut row = Map::new();
    for (key, value) in [
        ("id", json!(generate_id("brec"))),
        ("entityId", json!(entity_id)),
        ("bankAccountId", json!(bank_id)),
        ("ledgerAccountId", json!(ledger_id)),
        ("statementDate", json!(data.statement_date)),
        ("beginningBalance", json!(to_fixed(beginning, 2))),
        ("statementEndingBalance", json!(to_fixed(data.ending, 2))),
        ("clearedBalance", json!(to_fixed(beginning, 2))),
        ("difference", json!(to_fixed(round_money(data.ending - beginning), 2))),
        ("status", json!("in_progress")),
        ("clearedLineIds", json!([])),
        ("createdAt", json!(stamp)),
        ("updatedAt", json!(stamp)),
    ] {
        row.insert(key.to_owned(), value);
    }
    BANK_RECONCILIATIONS
        .insert_raw(db, BANK_RECONCILIATIONS.values(&row))
        .await?;
    Ok(Value::Object(row))
}

// ── GET /:id, GET /:id/report ───────────────────────────────────────────────

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    let result = async {
        let rec = find(&caller, &id).await?;
        Ok(ok(reconciliation_view(&caller.db, &rec).await.map_err(internal)?))
    }
    .await;
    reply(result, "Failed to fetch the reconciliation")
}

async fn report(caller: Caller, Path(id): Path<String>) -> Response {
    let result = async {
        let rec = find(&caller, &id).await?;
        Ok(ok(get_report(&caller.db, &rec).await.map_err(user_fixable)?))
    }
    .await;
    reply(result, "Failed to build the reconciliation report")
}

// ── PATCH /:id ──────────────────────────────────────────────────────────────

struct ProgressBody {
    cleared_line_ids: Option<Vec<String>>,
    statement_date: Option<String>,
    ending: Option<f64>,
}

async fn save(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, |issues, body| {
        let mut late = Vec::new();
        let ids = line_ids(issues, body);
        let date = day(issues, body, "statementDate", Presence::Optional);
        let ending = money(issues, body, "statementEndingBalance", Presence::Optional, &mut late);
        settle(issues, late);
        ProgressBody {
            cleared_line_ids: ids.into_option(),
            statement_date: date.into_option(),
            ending,
        }
    }) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond("Failed to save the reconciliation"),
    };
    let result = async {
        let rec = find(&caller, &id).await?;
        let saved = save_progress(&caller.db, &rec, &data).await.map_err(user_fixable)?;
        caller.publish(&state, BANK_RECONCILIATION_UPDATED, &id, event_data(&saved));
        Ok(ok(reconciliation_view(&caller.db, &saved).await.map_err(user_fixable)?))
    }
    .await;
    reply(result, "Failed to save the reconciliation")
}

fn unique(ids: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for id in ids {
        if !out.contains(id) {
            out.push(id.clone());
        }
    }
    out
}

/// `saveProgress(db, rec, patch)`.
async fn save_progress(db: &PgPool, rec: &Value, patch: &ProgressBody) -> Result<Value, Failure> {
    if text(rec, "status") != Some("in_progress") {
        return Err(posting("Only a reconciliation in progress can be changed"));
    }
    let last: Option<String> = sqlx::query_scalar(
        "select statement_date::text from bank_reconciliations where bank_account_id = $1 and status = 'completed' \
         order by statement_date desc limit 1",
    )
    .bind(text(rec, "bankAccountId"))
    .fetch_optional(db)
    .await?;
    if let (Some(date), Some(last)) = (patch.statement_date.as_deref().filter(|d| !d.is_empty()), &last)
        && date <= last.as_str()
    {
        return Err(posting(format!(
            "The statement date must be after the last reconciled statement ({last})."
        )));
    }
    let mut next = rec.as_object().cloned().unwrap_or_default();
    if let Some(date) = &patch.statement_date {
        next.insert("statementDate".to_owned(), json!(date));
    }
    if let Some(ending) = patch.ending {
        next.insert("statementEndingBalance".to_owned(), json!(to_fixed(ending, 2)));
    }
    let ids = patch.cleared_line_ids.clone().unwrap_or_else(|| cleared_ids(rec));
    next.insert("clearedLineIds".to_owned(), json!(ids));
    let next = Value::Object(next);
    let (open, _) = split_netted(load_lines(db, &next, "open").await?);
    if let Some(unknown) = ids.iter().find(|id| !open.iter().any(|l| &l.id == *id)) {
        return Err(posting(format!(
            "Line {unknown} is not open on or before {} (already cleared, not on this account, or dated later)",
            text(&next, "statementDate").unwrap_or_default()
        )));
    }
    let ledger = load_ledger(db, rec).await?;
    let ids = unique(&ids);
    let ticked: Vec<&LedgerLine> = ids
        .iter()
        .filter_map(|id| open.iter().find(|l| &l.id == id))
        .collect();
    let b = balances(&next, &ticked, text(&ledger, "type") == Some("liability"));
    let stamp = now();
    let mut update = Map::new();
    update.insert("statementDate".to_owned(), field(&next, "statementDate"));
    update.insert("statementEndingBalance".to_owned(), field(&next, "statementEndingBalance"));
    update.insert("clearedLineIds".to_owned(), json!(ids));
    update.insert("clearedBalance".to_owned(), json!(to_fixed(b.cleared, 2)));
    update.insert("difference".to_owned(), json!(to_fixed(b.difference, 2)));
    update.insert("updatedAt".to_owned(), json!(stamp));
    BANK_RECONCILIATIONS
        .patch_raw(db, text(rec, "id").unwrap_or_default(), BANK_RECONCILIATIONS.values(&update), false)
        .await?;
    let mut saved = rec.as_object().cloned().unwrap_or_default();
    saved.extend(update);
    Ok(Value::Object(saved))
}

// ── POST /:id/complete ──────────────────────────────────────────────────────

struct CompleteBody {
    cleared_line_ids: Option<Vec<String>>,
    adjustment: Option<(String, Option<String>)>,
}

async fn complete(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, |issues, body| {
        let ids = line_ids(issues, body);
        let adjustment = issues.nested(body, "adjustment", Presence::Optional, |issues, fields| {
            let account = issues.text(fields, "accountId", Presence::Required, Some(1), Some(30));
            let memo = issues.text(fields, "memo", Presence::Optional, None, Some(255));
            (account.into_option().unwrap_or_default(), memo.into_option())
        });
        CompleteBody {
            cleared_line_ids: ids.into_option(),
            adjustment: adjustment.into_option(),
        }
    }) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond("Failed to complete the reconciliation"),
    };
    let result = async {
        let rec = find(&caller, &id).await?;
        let (done, adjustment_entry) = complete_reconciliation(&caller.db, &rec, &data, caller.user())
            .await
            .map_err(user_fixable)?;
        write_accounting_audit(
            &caller,
            &caller.db,
            AuditInput {
                accounting_entity_id: text(&rec, "entityId"),
                entity_type: "bank_reconciliation",
                entity_id: &id,
                action: "completed",
                changes: Some(changes(vec![
                    ("status", field(&rec, "status"), json!("completed")),
                    ("clearedBalance", field(&rec, "clearedBalance"), field(&done, "clearedBalance")),
                    ("adjustmentJournalEntryId", Value::Null, json!(adjustment_entry)),
                ])),
            },
        )
        .await;
        caller.publish(&state, BANK_RECONCILIATION_COMPLETED, &id, event_data(&done));
        let mut view = reconciliation_view(&caller.db, &done).await.map_err(user_fixable)?;
        if let Value::Object(map) = &mut view {
            map.insert("adjustmentJournalEntryId".to_owned(), json!(adjustment_entry));
        }
        Ok(ok(view))
    }
    .await;
    reply(result, "Failed to complete the reconciliation")
}

/// The statements that finish a reconciliation: stamp the cleared lines
/// (and the adjustment's bank line) and close it.
#[allow(clippy::too_many_arguments)]
async fn finish(
    conn: &mut sqlx::PgConnection,
    rec_id: &str,
    ledger_id: &str,
    stamp_ids: &[String],
    ticked_ids: &[String],
    cleared_balance: &str,
    report: Value,
    adjustment_entry: Option<&str>,
    user_id: Option<&str>,
    stamp: &str,
) -> Result<(), sqlx::Error> {
    if !stamp_ids.is_empty() {
        sqlx::query("update journal_lines set reconciliation_id = $2, reconciled = true, updated_at = $3::timestamp where id = any($1)")
            .bind(stamp_ids)
            .bind(rec_id)
            .bind(stamp)
            .execute(&mut *conn)
            .await?;
    }
    if let Some(entry) = adjustment_entry {
        sqlx::query(
            "update journal_lines set reconciliation_id = $3, reconciled = true, updated_at = $4::timestamp \
             where journal_entry_id = $1 and account_id = $2",
        )
        .bind(entry)
        .bind(ledger_id)
        .bind(rec_id)
        .bind(stamp)
        .execute(&mut *conn)
        .await?;
    }
    sqlx::query(
        "update bank_reconciliations set status = 'completed', cleared_line_ids = $2, cleared_balance = $3::numeric, \
         difference = '0.00', adjustment_journal_entry_id = $4, report = $5, completed_at = $6::timestamp, \
         completed_by = $7, updated_at = $6::timestamp where id = $1 and status = 'in_progress'",
    )
    .bind(rec_id)
    .bind(json!(ticked_ids))
    .bind(cleared_balance)
    .bind(adjustment_entry)
    .bind(report)
    .bind(stamp)
    .bind(user_id)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// `completeReconciliation(db, rec, args)`.
#[allow(clippy::too_many_lines)] // the worker's steps, in its order
async fn complete_reconciliation(
    db: &PgPool,
    rec: &Value,
    data: &CompleteBody,
    user_id: Option<&str>,
) -> Result<(Value, Option<String>), Failure> {
    if text(rec, "status") != Some("in_progress") {
        return Err(posting("Only a reconciliation in progress can be completed"));
    }
    let ledger = load_ledger(db, rec).await?;
    let liability = text(&ledger, "type") == Some("liability");
    let ledger_id = text(&ledger, "id").unwrap_or_default().to_owned();
    let (open, netted) = split_netted(load_lines(db, rec, "open").await?);
    let ticked_ids = unique(&data.cleared_line_ids.clone().unwrap_or_else(|| cleared_ids(rec)));
    if let Some(unknown) = ticked_ids.iter().find(|id| !open.iter().any(|l| &l.id == *id)) {
        return Err(posting(format!(
            "Line {unknown} is not open on or before {} (already cleared, not on this account, or dated later)",
            text(rec, "statementDate").unwrap_or_default()
        )));
    }
    let ticked: Vec<&LedgerLine> = ticked_ids
        .iter()
        .filter_map(|id| open.iter().find(|l| &l.id == id))
        .collect();
    let b = balances(rec, &ticked, liability);
    let uncleared: Vec<&LedgerLine> = open.iter().filter(|l| !ticked_ids.contains(&l.id)).collect();
    let bank_name = bank_account_name(db, rec).await?;
    let differs = b.difference.abs() >= EPSILON;
    let Some((account_id, memo)) = data.adjustment.clone().or_else(|| (!differs).then(|| (String::new(), None))) else {
        return Err(posting(format!(
            "The difference is {}. It must be 0.00 to finish: tick the lines that cleared, or post the difference to an account.",
            to_fixed(b.difference, 2)
        )));
    };
    let rec_id = text(rec, "id").unwrap_or_default().to_owned();
    let stamp_ids: Vec<String> = ticked_ids
        .iter()
        .cloned()
        .chain(netted.iter().map(|l| l.id.clone()))
        .collect();
    let stamp = now();

    if !differs {
        let report = build_report(db, rec, &ledger, bank_name.as_deref(), &ticked, &uncleared, None).await?;
        let mut tx = db.begin().await?;
        finish(
            &mut tx,
            &rec_id,
            &ledger_id,
            &stamp_ids,
            &ticked_ids,
            &to_fixed(round_money(b.cleared), 2),
            report,
            None,
            user_id,
            &stamp,
        )
        .await?;
        tx.commit().await?;
        return Ok((reload(db, &rec_id).await?, None));
    }

    let accounts = load_entity_accounts(db, text(rec, "entityId").unwrap_or_default()).await?;
    let Some(adjustment_account) = accounts.by_id(Some(&account_id)) else {
        return Err(posting("The adjustment account does not belong to this accounting entity"));
    };
    let adjustment_id = text(adjustment_account, "id").unwrap_or_default().to_owned();
    if adjustment_id == ledger_id {
        return Err(posting("Post the adjustment to another account than the bank account itself"));
    }
    let amount = b.difference.abs();
    let raises_ledger_debit = (b.difference > 0.0) != liability;
    let memo = memo
        .as_deref()
        .map(weldsuite_books_domain::jurisdictions::js_trim)
        .filter(|m| !m.is_empty())
        .map(str::to_owned);
    let statement_date = text(rec, "statementDate").unwrap_or_default().to_owned();
    let description = format!(
        "Reconciliation adjustment{} (statement {statement_date})",
        memo.as_ref().map(|m| format!(" — {m}")).unwrap_or_default()
    );
    let adjustment = json!({
        "journalEntryId": null,
        "amount": number_value(amount),
        "difference": number_value(b.difference),
        "accountId": adjustment_id,
        "accountName": field(adjustment_account, "name"),
        "memo": memo,
    });
    let base_report = build_report(
        db,
        rec,
        &ledger,
        bank_name.as_deref(),
        &ticked,
        &uncleared,
        Some(&adjustment),
    )
    .await?;
    let with_entry = move |entry: &str| {
        let mut report = base_report.clone();
        report["adjustment"]["journalEntryId"] = json!(entry);
        report
    };
    let cleared_balance = to_fixed(round_money(b.cleared + b.difference), 2);
    let side = |account: &str, debit: bool| PostingLine {
        account_id: account.to_owned(),
        debit: if debit { amount } else { 0.0 },
        credit: if debit { 0.0 } else { amount },
        description: Some(description.clone()),
        ..PostingLine::default()
    };
    let lines = vec![
        side(&ledger_id, raises_ledger_debit),
        side(&adjustment_id, !raises_ledger_debit),
    ];
    let write_parts = (
        rec_id.clone(),
        ledger_id.clone(),
        stamp_ids.clone(),
        ticked_ids.clone(),
        cleared_balance.clone(),
        user_id.map(str::to_owned),
        stamp.clone(),
        with_entry.clone(),
    );
    let write: AlsoWrite = Box::new(move |conn, posted| {
        Box::pin(async move {
            let (rec_id, ledger_id, stamp_ids, ticked_ids, cleared, user, stamp, with_entry) = write_parts;
            finish(
                conn,
                &rec_id,
                &ledger_id,
                &stamp_ids,
                &ticked_ids,
                &cleared,
                with_entry(&posted.journal_entry_id),
                Some(&posted.journal_entry_id),
                user.as_deref(),
                &stamp,
            )
            .await
        })
    });
    let posted = post_journal_entry(
        db,
        PostJournalEntryInput {
            entity_id: text(rec, "entityId").unwrap_or_default().to_owned(),
            date: format!("{statement_date}T00:00:00.000Z"),
            description: description.clone(),
            source_type: "bank_reconciliation".to_owned(),
            source_id: Some(rec_id.clone()),
            posting_key: Some(format!("bank_reconciliation:{rec_id}:adjustment")),
            lock_kind: Some(PostingLockKind::General),
            created_by: user_id.map(str::to_owned),
            lines,
            also_write: vec![write],
            ..PostJournalEntryInput::default()
        },
    )
    .await?;
    if posted.already_posted
        && let Some(entry) = posted.journal_entry_id.as_deref()
    {
        let mut tx = db.begin().await?;
        finish(
            &mut tx,
            &rec_id,
            &ledger_id,
            &stamp_ids,
            &ticked_ids,
            &cleared_balance,
            with_entry(entry),
            Some(entry),
            user_id,
            &stamp,
        )
        .await?;
        tx.commit().await?;
    }
    Ok((reload(db, &rec_id).await?, posted.journal_entry_id))
}

// ── POST /:id/undo ──────────────────────────────────────────────────────────

async fn undo(caller: Caller, State(state): State<BooksState>, Path(id): Path<String>) -> Response {
    let result = async {
        let rec = find(&caller, &id).await?;
        let undone = undo_reconciliation(&caller.db, &rec, caller.user())
            .await
            .map_err(user_fixable)?;
        write_accounting_audit(
            &caller,
            &caller.db,
            AuditInput {
                accounting_entity_id: text(&rec, "entityId"),
                entity_type: "bank_reconciliation",
                entity_id: &id,
                action: "undone",
                changes: Some(changes(vec![
                    ("status", field(&rec, "status"), json!("undone")),
                    ("statementDate", field(&rec, "statementDate"), field(&rec, "statementDate")),
                    ("adjustmentJournalEntryId", field(&rec, "adjustmentJournalEntryId"), Value::Null),
                ])),
            },
        )
        .await;
        caller.publish(&state, BANK_RECONCILIATION_UNDONE, &id, event_data(&undone));
        Ok(ok(reconciliation_view(&caller.db, &undone).await.map_err(user_fixable)?))
    }
    .await;
    reply(result, "Failed to undo the reconciliation")
}

/// The undo's statements: the stamps cleared, the reconciliation undone.
async fn release(
    conn: &mut sqlx::PgConnection,
    id: &str,
    stamp: &str,
    user: Option<&str>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "update journal_lines set reconciliation_id = null, reconciled = false, updated_at = $2::timestamp \n         where reconciliation_id = $1",
    )
    .bind(id)
    .bind(stamp)
    .execute(&mut *conn)
    .await?;
    sqlx::query(
        "update bank_reconciliations set status = 'undone', undone_at = $2::timestamp, undone_by = $3, \n         updated_at = $2::timestamp where id = $1 and status = 'completed'",
    )
    .bind(id)
    .bind(stamp)
    .bind(user)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// `undoReconciliation(db, rec, { userId })`: only the latest completed one.
#[allow(clippy::single_match_else)]
async fn undo_reconciliation(db: &PgPool, rec: &Value, user_id: Option<&str>) -> Result<Value, Failure> {
    if text(rec, "status") != Some("completed") {
        return Err(posting("Only a completed reconciliation can be undone"));
    }
    let completed_at = text(rec, "completedAt")
        .filter(|c| !c.is_empty())
        .map_or_else(|| "1970-01-01T00:00:00.000Z".to_owned(), str::to_owned);
    let later: Option<String> = sqlx::query_scalar(
        "select statement_date::text from bank_reconciliations where bank_account_id = $1 and status = 'completed' \
         and id <> $2 and (statement_date > $3::date or (statement_date = $3::date and completed_at > $4::timestamp)) limit 1",
    )
    .bind(text(rec, "bankAccountId"))
    .bind(text(rec, "id"))
    .bind(text(rec, "statementDate"))
    .bind(&completed_at)
    .fetch_optional(db)
    .await?;
    if let Some(later) = later {
        return Err(posting(format!(
            "Undo the latest reconciliation first (statement of {later}). Only the most recent one can be undone."
        )));
    }
    let id = text(rec, "id").unwrap_or_default().to_owned();
    let stamp = now();
    let user = user_id.map(str::to_owned);
    match text(rec, "adjustmentJournalEntryId").filter(|e| !e.is_empty()) {
        Some(entry) => {
            let (rid, at, who) = (id.clone(), stamp.clone(), user.clone());
            let write: AlsoWrite = Box::new(move |conn, _| {
                Box::pin(async move { release(conn, &rid, &at, who.as_deref()).await })
            });
            reverse_journal_entry(
                db,
                ReverseArgs {
                    entry_id: entry.to_owned(),
                    date: stamp,
                    created_by: user,
                    description: Some(format!(
                        "Undo reconciliation adjustment (statement {})",
                        text(rec, "statementDate").unwrap_or_default()
                    )),
                    also_write: vec![write],
                    ..ReverseArgs::default()
                },
            )
            .await?;
        }
        None => {
            let mut tx = db.begin().await?;
            release(&mut tx, &id, &stamp, user.as_deref()).await?;
            tx.commit().await?;
        }
    }
    Ok(reload(db, &id).await?)
}

// ── DELETE /:id ─────────────────────────────────────────────────────────────

async fn discard(caller: Caller, State(state): State<BooksState>, Path(id): Path<String>) -> Response {
    let result: Reply = async {
        let rec = find(&caller, &id).await?;
        if text(&rec, "status") != Some("in_progress") {
            return Err(Refusal::bad_request("Only a reconciliation in progress can be discarded"));
        }
        sqlx::query("delete from bank_reconciliations where id = $1 and status = 'in_progress'")
            .bind(&id)
            .execute(&caller.db)
            .await?;
        write_accounting_audit(
            &caller,
            &caller.db,
            AuditInput {
                accounting_entity_id: text(&rec, "entityId"),
                entity_type: "bank_reconciliation",
                entity_id: &id,
                action: "deleted",
                changes: Some(changes(vec![("status", field(&rec, "status"), Value::Null)])),
            },
        )
        .await;
        caller.publish(&state, BANK_RECONCILIATION_DELETED, &id, event_data(&rec));
        Ok(no_content())
    }
    .await;
    reply(result, "Failed to discard the reconciliation")
}
