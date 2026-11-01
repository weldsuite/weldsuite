//! `/api/bank-transactions` (`routes/bank-transactions/index.ts`): statement
//! lines entered by hand (optionally posted straight to an account),
//! imported from a file (OFX / QFX / QBO, BAI2, CSV with a layout, MT940,
//! CAMT.053; previewed first), matched to invoices, bills, payments and
//! deposits, categorized, unreconciled and excluded. Every change is written
//! to the accounting audit log.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use weldsuite_books_domain::bank_matching::{
    auto_reconcile_batch, find_matches, reconcile_to_deposit, reconcile_to_document,
    reconcile_to_payment, unreconcile,
};
use weldsuite_books_domain::entity_context::resolve_entity_id;
use weldsuite_books_domain::guards::{AuditInput, write_accounting_audit};
use weldsuite_books_domain::http::{
    BooksState, Caller, Refusal, Reply, created, now, ok, paged, reply, validate,
};
use weldsuite_books_domain::js::{
    js_date, js_number_value, math_round, number_text, parse_int, to_fixed,
};
use weldsuite_books_domain::tables::{BANK_ACCOUNTS, BANK_IMPORT_BATCHES, BANK_TRANSACTIONS};
use weldsuite_catalogs::entity_events::{
    BANK_ACCOUNT_UPDATED, BANK_DEPOSIT_UPDATED, BANK_TRANSACTION_CREATED,
    BANK_TRANSACTION_UPDATED, JOURNAL_ENTRY_CREATED, PAYMENT_CREATED, PAYMENT_UPDATED,
};
use weldsuite_kit::generate_id;
use weldsuite_kit::validation::{
    Field, Issues, Number, Presence, js_number, string_or_number_issue,
};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::categorize::categorize;
use crate::common::{changes, field, find_transaction, posting_refusal, text};
use crate::csv_format;
use crate::import::{count_duplicates, import_transactions};
use crate::parsers::{CsvFormatRequired, ParseOptions, ParseResult, parse_bank_file};

const FILE_FORMATS: [&str; 7] = ["mt940", "camt053", "csv", "ofx", "qfx", "qbo", "bai2"];

pub(crate) fn router<S, Q>(state: BooksState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route("/", get(list).route_layer(need("banking:read")))
        .route("/", post(create).route_layer(need("banking:create")))
        .route(
            "/unreconciled",
            get(unreconciled).route_layer(need("banking:read")),
        )
        .route(
            "/import/preview",
            post(preview).route_layer(need("banking:create")),
        )
        .route("/import", post(import).route_layer(need("banking:create")))
        .route(
            "/auto-reconcile",
            post(auto_reconcile).route_layer(need("banking:update")),
        )
        .route("/{id}", get(detail).route_layer(need("banking:read")))
        .route(
            "/{id}/suggestions",
            get(suggestions).route_layer(need("banking:read")),
        )
        .route(
            "/{id}/match-deposit",
            post(match_deposit).route_layer(need("banking:update")),
        )
        .route(
            "/{id}/match-payment",
            post(match_payment).route_layer(need("banking:update")),
        )
        .route(
            "/{id}/reconcile",
            post(reconcile).route_layer(need("banking:update")),
        )
        .route(
            "/{id}/unreconcile",
            post(unreconcile_line).route_layer(need("banking:update")),
        )
        .route(
            "/{id}/exclude",
            post(exclude).route_layer(need("banking:update")),
        )
        .with_state(state)
}

/// `{ id, bankAccountId, amount: amount || '0', description, status }`: the
/// bank-line event the matching routes publish.
fn line_event(txn: &Value, status: &str) -> Value {
    json!({
        "id": field(txn, "id"),
        "bankAccountId": field(txn, "bankAccountId"),
        "amount": text(txn, "amount").filter(|a| !a.is_empty()).unwrap_or("0"),
        "description": field(txn, "description"),
        "status": status,
    })
}

// ── GET / ───────────────────────────────────────────────────────────────────

async fn list(caller: Caller) -> Response {
    reply(list_lines(&caller).await, "Failed to fetch bank transactions")
}

async fn list_lines(caller: &Caller) -> Reply {
    let q = caller.query();
    let page = parse_int(q.present("page").unwrap_or("1")).map(|p| p.max(1));
    let size = parse_int(q.present("pageSize").unwrap_or("25")).map(|s| s.clamp(1, 100));
    let Some(entity_id) = resolve_entity_id(caller).await? else {
        return Ok(paged(Vec::new(), 0, false, None));
    };
    let (Some(page), Some(size)) = (page, size) else {
        return Err(Refusal::Internal("page or pageSize is NaN".to_owned()));
    };
    let date_bound = |key: &str| -> Result<Option<String>, Refusal> {
        match q.present(key) {
            None => Ok(None),
            Some(raw) => js_date(raw)
                .map(Some)
                .ok_or_else(|| Refusal::Internal(format!("Invalid time value ({key})"))),
        }
    };
    let from = date_bound("from")?;
    let to = date_bound("to")?;
    let search = q.present("search");
    let term = search.map(|s| format!("%{s}%"));
    let exact = search.map(|s| weldsuite_books_domain::jurisdictions::js_trim(s).to_owned());
    let filters = (
        q.present("bankAccountId"),
        q.present("status"),
        q.present("checkNumber"),
        q.present("source"),
        q.present("depositId"),
    );
    let rows: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(bank_transactions),
        " from bank_transactions t where t.deleted_at is null and t.entity_id = $1 \
         and ($2::text is null or t.bank_account_id = $2) and ($3::text is null or t.status = $3) \
         and ($4::text is null or t.check_number = $4) and ($5::text is null or t.source = $5) \
         and ($6::text is null or t.deposit_id = $6) \
         and ($7::text is null or t.date >= $7::timestamp) and ($8::text is null or t.date <= $8::timestamp) \
         and ($9::text is null or t.description like $9 or t.counterparty_name like $9 \
              or t.reference like $9 or t.check_number = $10) \
         order by t.date desc limit $11 offset $12"
    ))
    .bind(&entity_id)
    .bind(filters.0)
    .bind(filters.1)
    .bind(filters.2)
    .bind(filters.3)
    .bind(filters.4)
    .bind(from.as_deref())
    .bind(to.as_deref())
    .bind(term.as_deref())
    .bind(exact.as_deref())
    .bind(size)
    .bind((page - 1) * size)
    .fetch_all(&caller.db)
    .await?;
    let total: i64 = sqlx::query_scalar(
        "select count(*)::int8 from bank_transactions t where t.deleted_at is null and t.entity_id = $1 \
         and ($2::text is null or t.bank_account_id = $2) and ($3::text is null or t.status = $3) \
         and ($4::text is null or t.check_number = $4) and ($5::text is null or t.source = $5) \
         and ($6::text is null or t.deposit_id = $6) \
         and ($7::text is null or t.date >= $7::timestamp) and ($8::text is null or t.date <= $8::timestamp) \
         and ($9::text is null or t.description like $9 or t.counterparty_name like $9 \
              or t.reference like $9 or t.check_number = $10)",
    )
    .bind(&entity_id)
    .bind(filters.0)
    .bind(filters.1)
    .bind(filters.2)
    .bind(filters.3)
    .bind(filters.4)
    .bind(from.as_deref())
    .bind(to.as_deref())
    .bind(term.as_deref())
    .bind(exact.as_deref())
    .fetch_one(&caller.db)
    .await?;
    Ok(paged(
        BANK_TRANSACTIONS.js_rows(rows),
        total,
        page * size < total,
        None,
    ))
}

// ── GET /unreconciled ───────────────────────────────────────────────────────

async fn unreconciled(caller: Caller) -> Response {
    let result = async {
        let Some(entity_id) = resolve_entity_id(&caller).await? else {
            return Err(Refusal::bad_request("No accounting entity resolved"));
        };
        let account = caller.query().present("bankAccountId").map(str::to_owned);
        let rows: Vec<Value> = sqlx::query_scalar(concat!(
            "select ",
            weldsuite_books_domain::books_row!(bank_transactions),
            " from bank_transactions t where t.deleted_at is null and t.entity_id = $1 \
             and t.status = 'unreconciled' and ($2::text is null or t.bank_account_id = $2) \
             order by t.date desc limit 100"
        ))
        .bind(&entity_id)
        .bind(account)
        .fetch_all(&caller.db)
        .await?;
        Ok(ok(Value::Array(BANK_TRANSACTIONS.js_rows(rows))))
    }
    .await;
    reply(result, "Failed to fetch unreconciled transactions")
}

// ── POST / ──────────────────────────────────────────────────────────────────

/// `createBankTransactionSchema` (`@weldsuite/core-api-client/schemas/bank-transactions`).
struct ManualBody {
    bank_account_id: String,
    date: String,
    amount: Value,
    description: Option<String>,
    value_date: Option<String>,
    counterparty_name: Option<String>,
    counterparty_iban: Option<String>,
    counterparty_bic: Option<String>,
    reference: Option<String>,
    notes: Option<String>,
    category_account_id: Option<String>,
}

fn read_manual(issues: &mut Issues, body: &Map<String, Value>) -> Option<ManualBody> {
    let text_field = |issues: &mut Issues, key: &str, min: Option<usize>, max: Option<usize>| {
        issues
            .text(body, key, Presence::Optional, min, max)
            .into_option()
    };
    let account = issues.text(body, "bankAccountId", Presence::Required, Some(1), None);
    let date = issues.text(body, "date", Presence::Required, Some(1), None);
    // `z.union([z.string(), z.number()]).refine(non-zero)`: both settle after
    // the synchronous checks.
    let amount = body.get("amount").cloned();
    let description = text_field(issues, "description", None, None);
    let value_date = text_field(issues, "valueDate", None, None);
    let counterparty_name = text_field(issues, "counterpartyName", None, Some(255));
    let counterparty_iban = text_field(issues, "counterpartyIban", None, Some(50));
    let counterparty_bic = text_field(issues, "counterpartyBic", None, Some(11));
    let reference = text_field(issues, "reference", None, Some(255));
    let notes = text_field(issues, "notes", None, None);
    let category = text_field(issues, "categoryAccountId", Some(1), None);
    let amount = match amount {
        Some(value @ (Value::String(_) | Value::Number(_))) => {
            let number = match &value {
                Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
                Value::String(s) => js_number(s),
                _ => f64::NAN,
            };
            if !number.is_finite() || number == 0.0 {
                issues.custom("amount", "Amount must be a non-zero number");
                None
            } else {
                Some(value)
            }
        }
        other => {
            issues.push_raw(string_or_number_issue(&issues.path_of("amount"), other.as_ref()));
            None
        }
    };
    Some(ManualBody {
        bank_account_id: account.into_option()?,
        date: date.into_option()?,
        amount: amount?,
        description,
        value_date,
        counterparty_name,
        counterparty_iban,
        counterparty_bic,
        reference,
        notes,
        category_account_id: category,
    })
}

/// The route's own `roundMoney`: `(Math.round(v * 100) / 100).toFixed(2)`.
fn round_text(value: f64) -> String {
    to_fixed(math_round(value * 100.0) / 100.0, 2)
}

/// `value?.trim() || null`
fn trimmed(value: Option<&str>) -> Option<String> {
    value
        .map(weldsuite_books_domain::jurisdictions::js_trim)
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
}

async fn create(caller: Caller, State(state): State<BooksState>, headers: HeaderMap, body: Bytes) -> Response {
    let data = match validate(&headers, &body, read_manual) {
        Ok(Some(data)) => data,
        Ok(None) => return Refusal::Internal("unread body".to_owned()).respond("Failed to create bank transaction"),
        Err(refusal) => return refusal.respond("Failed to create bank transaction"),
    };
    reply(create_line(&caller, &state, data).await, "Failed to create bank transaction")
}

#[allow(clippy::too_many_lines)] // mirrors the TypeScript route step by step
async fn create_line(caller: &Caller, state: &BooksState, data: ManualBody) -> Reply {
    let Some(bank) = BANK_ACCOUNTS.find_live(&caller.db, &data.bank_account_id).await? else {
        return Err(Refusal::not_found("Bank account", &data.bank_account_id));
    };
    if data.category_account_id.is_some() && text(&bank, "ledgerAccountId").is_none_or(str::is_empty) {
        return Err(Refusal::bad_request(
            "This bank account is not linked to a ledger account. Edit the bank account and choose a GL account first.",
        ));
    }
    let Some(posted_on) = js_date(&data.date) else {
        return Err(Refusal::bad_request("Invalid date"));
    };
    let value_date = match data.value_date.as_deref().filter(|v| !v.is_empty()) {
        Some(raw) => match js_date(raw) {
            Some(parsed) => Some(parsed),
            None => return Err(Refusal::bad_request("Invalid valueDate")),
        },
        None => None,
    };
    let number = match &data.amount {
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::String(s) => js_number(s),
        _ => f64::NAN,
    };
    let amount = round_text(number);
    let previous = js_number(text(&bank, "currentBalance").filter(|b| !b.is_empty()).unwrap_or("0"));
    let running = round_text(previous + js_number(&amount));
    let stamp = now();
    let id = generate_id("bt");
    let iban = data
        .counterparty_iban
        .as_deref()
        .filter(|v| !v.is_empty())
        .map(|v| {
            v.chars()
                .filter(|c| !weldsuite_books_domain::jurisdictions::is_js_space(*c))
                .collect::<String>()
                .to_uppercase()
        });
    let bic = data
        .counterparty_bic
        .as_deref()
        .map(|v| weldsuite_books_domain::jurisdictions::js_trim(v).to_uppercase())
        .filter(|v| !v.is_empty());
    let mut txn = Map::new();
    for (key, value) in [
        ("id", json!(id)),
        ("entityId", field(&bank, "entityId")),
        ("bankAccountId", json!(data.bank_account_id)),
        ("date", json!(posted_on)),
        ("valueDate", json!(value_date)),
        ("description", json!(trimmed(data.description.as_deref()))),
        ("amount", json!(amount)),
        ("runningBalance", json!(running)),
        ("counterpartyName", json!(trimmed(data.counterparty_name.as_deref()))),
        ("counterpartyIban", json!(iban)),
        ("counterpartyBic", json!(bic)),
        ("reference", json!(trimmed(data.reference.as_deref()))),
        ("notes", json!(trimmed(data.notes.as_deref()))),
        ("importBatchId", Value::Null),
        ("externalId", Value::Null),
        ("status", json!("unreconciled")),
        ("source", json!("manual")),
        ("rawData", json!({ "source": "manual" })),
        ("createdAt", json!(stamp)),
        ("updatedAt", json!(stamp)),
    ] {
        txn.insert(key.to_owned(), value);
    }
    BANK_TRANSACTIONS
        .insert_raw(&caller.db, BANK_TRANSACTIONS.values(&txn))
        .await?;
    sqlx::query("update bank_accounts set current_balance = $2::numeric, updated_at = $3::timestamp where id = $1")
        .bind(&data.bank_account_id)
        .bind(&running)
        .bind(&stamp)
        .execute(&caller.db)
        .await?;

    let mut journal_entry_id: Option<String> = None;
    if let Some(category) = &data.category_account_id {
        let Some(inserted) = find_transaction(&caller.db, &id).await? else {
            return Err(Refusal::Internal("Failed to create bank transaction".to_owned()));
        };
        let posted = categorize(&caller.db, &inserted, category, None, None, caller.user())
            .await
            .map_err(posting_refusal)?;
        journal_entry_id = Some(posted.journal_entry_id);
    }

    let entity_id = text(&bank, "entityId").unwrap_or_default().to_owned();
    let mut audit = vec![
        ("bankAccountId", Value::Null, json!(data.bank_account_id)),
        ("date", Value::Null, json!(posted_on)),
        ("amount", Value::Null, json!(amount)),
        ("description", Value::Null, field(&Value::Object(txn.clone()), "description")),
        ("source", Value::Null, json!("manual")),
    ];
    if let Some(entry) = &journal_entry_id {
        audit.push(("journalEntryId", Value::Null, json!(entry)));
    }
    write_accounting_audit(
        caller,
        &caller.db,
        AuditInput {
            accounting_entity_id: Some(&entity_id),
            entity_type: "bank_transaction",
            entity_id: &id,
            action: "created",
            changes: Some(changes(audit)),
        },
    )
    .await;
    let status = if journal_entry_id.is_some() { "reconciled" } else { "unreconciled" };
    caller.publish(
        state,
        BANK_TRANSACTION_CREATED,
        &id,
        json!({
            "id": id,
            "bankAccountId": data.bank_account_id,
            "amount": amount,
            "description": txn.get("description"),
            "date": posted_on,
            "status": status,
        }),
    );
    if let Some(entry) = &journal_entry_id {
        caller.publish(
            state,
            JOURNAL_ENTRY_CREATED,
            entry,
            json!({ "id": entry, "sourceType": "bank_transaction", "sourceId": id }),
        );
    }
    txn.insert("status".to_owned(), json!(status));
    txn.insert("journalEntryId".to_owned(), json!(journal_entry_id));
    txn.insert("categoryAccountId".to_owned(), json!(data.category_account_id));
    Ok(created(Value::Object(txn)))
}

// ── POST /import/preview, POST /import ──────────────────────────────────────

struct FileBody {
    bank_account_id: Option<String>,
    content: String,
    file_name: Option<String>,
    format: Option<String>,
    csv_format: Option<Value>,
    sample_size: usize,
    remember_csv_format: bool,
    ignore_account_mismatch: bool,
}

/// `importSchema`, or `previewSchema` when `preview`.
fn read_file_body(issues: &mut Issues, body: &Map<String, Value>, preview: bool) -> FileBody {
    let maybe = if preview { Presence::Optional } else { Presence::Required };
    let account = issues.text(body, "bankAccountId", maybe, Some(1), None);
    let content = issues.text(body, "content", Presence::Required, Some(1), None);
    let file_name = issues.text(body, "fileName", maybe, Some(1), None);
    let format = issues.choice(body, "format", Presence::Optional, &FILE_FORMATS);
    let mut deferred = csv_format::Deferred::default();
    let csv = csv_format::read(issues, body, "csvFormat", Presence::Optional, &mut deferred);
    let mut sample_size = 20;
    let mut remember = false;
    let mut ignore = false;
    if preview {
        if let Field::Set(size) = issues.number(
            body,
            "sampleSize",
            Presence::Optional,
            Number {
                coerce: false,
                int: true,
                min: Some(1.0),
                max: Some(100.0),
            },
        ) {
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
            {
                sample_size = size as usize;
            }
        }
    } else {
        remember = issues
            .boolean(body, "rememberCsvFormat", Presence::Optional)
            .into_option()
            .unwrap_or(false);
        ignore = issues
            .boolean(body, "ignoreAccountMismatch", Presence::Optional)
            .into_option()
            .unwrap_or(false);
    }
    deferred.settle(issues);
    FileBody {
        bank_account_id: account.into_option(),
        content: content.into_option().unwrap_or_default(),
        file_name: file_name.into_option(),
        format: format.into_option(),
        csv_format: csv.into_option(),
        sample_size,
        remember_csv_format: remember,
        ignore_account_mismatch: ignore,
    }
}

/// `csvFormatFor(requested, account)`: the layout sent, else the one
/// remembered on the account (when it still reads).
fn csv_format_for(requested: Option<&Value>, account: &Value) -> Option<Value> {
    requested.cloned().or_else(|| {
        csv_format::parse_stored(account.get("importSettings").and_then(|s| s.get("csv")))
    })
}

fn last4(value: &str) -> String {
    let units: Vec<u16> = value.encode_utf16().collect();
    String::from_utf16_lossy(&units[units.len().saturating_sub(4)..])
}

/// `fileProblem(parse, account)`: why a file can't go into this account.
fn file_problem(parse: &ParseResult, account: &Value) -> Option<(&'static str, String, Value)> {
    let name = text(account, "name").unwrap_or_default();
    let file_number = parse
        .account
        .as_ref()
        .and_then(|a| a.account_number.as_deref())
        .filter(|n| !n.is_empty());
    let bank_last4 = text(account, "accountNumberLast4").filter(|n| !n.is_empty());
    if let (Some(file_number), Some(bank_last4)) = (file_number, bank_last4)
        && last4(file_number).to_lowercase() != last4(bank_last4).to_lowercase()
    {
        let file_last4 = last4(file_number);
        return Some((
            "ACCOUNT_MISMATCH",
            format!(
                "This file is for the account ending {file_last4}, but {name} ends in {bank_last4}. Pick the right bank account, or import anyway."
            ),
            json!({ "fileAccountLast4": file_last4, "bankAccountLast4": bank_last4 }),
        ));
    }
    let file_currency = parse.currency.as_deref().filter(|c| !c.is_empty());
    let bank_currency = text(account, "currency").filter(|c| !c.is_empty());
    if let (Some(file_currency), Some(bank_currency)) = (file_currency, bank_currency)
        && file_currency.to_uppercase() != bank_currency.to_uppercase()
    {
        return Some((
            "CURRENCY_MISMATCH",
            format!(
                "This file is in {file_currency} but {name} is in {bank_currency}. Pick the right bank account, or import anyway."
            ),
            json!({ "fileCurrency": file_currency, "bankAccountCurrency": bank_currency }),
        ));
    }
    None
}

fn error_response(status: StatusCode, code: &str, message: &str, details: &Value) -> Response {
    (
        status,
        axum::Json(json!({ "error": { "code": code, "message": message, "details": details } })),
    )
        .into_response()
}

async fn preview(caller: Caller, headers: HeaderMap, body: Bytes) -> Response {
    let data = match validate(&headers, &body, |issues, body| read_file_body(issues, body, true)) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond("Failed to read the bank file: unknown error"),
    };
    let result = preview_file(&caller, data).await;
    result.unwrap_or_else(|refusal| match refusal {
        Refusal::Database(error) => {
            Refusal::Internal(String::new()).respond(&format!("Failed to read the bank file: {error}"))
        }
        other => other.respond("Failed to read the bank file: unknown error"),
    })
}

fn optional_number(value: Option<f64>) -> Option<Value> {
    value.map(weldsuite_books_domain::js::number_value)
}

#[allow(clippy::too_many_lines)] // the preview's fields, as the worker lists them
async fn preview_file(caller: &Caller, data: FileBody) -> Reply {
    let account = match &data.bank_account_id {
        Some(id) => match BANK_ACCOUNTS.find_live(&caller.db, id).await? {
            Some(account) => Some(account),
            None => return Err(Refusal::not_found("Bank account", id)),
        },
        None => None,
    };
    let options = ParseOptions {
        file_name: data.file_name.clone(),
        csv_format: match &account {
            Some(account) => csv_format_for(data.csv_format.as_ref(), account),
            None => data.csv_format.clone(),
        },
        account_last4: account
            .as_ref()
            .and_then(|a| text(a, "accountNumberLast4"))
            .map(str::to_owned),
    };
    let parse = match parse_bank_file(&data.content, data.format.as_deref(), &options) {
        Ok(parse) => parse,
        Err(CsvFormatRequired { proposal, .. }) => {
            return Ok(ok(json!({ "format": "csv", "needsCsvFormat": true, "proposal": proposal })));
        }
    };
    let duplicates = match &account {
        Some(account) => Some(
            count_duplicates(&caller.db, text(account, "id").unwrap_or_default(), &parse.transactions).await?,
        ),
        None => None,
    };
    let problem = account.as_ref().and_then(|a| file_problem(&parse, a));
    let mut out = Map::new();
    out.insert("format".to_owned(), json!(parse.format));
    out.insert("needsCsvFormat".to_owned(), json!(false));
    let remembered = account
        .as_ref()
        .is_some_and(|a| weldsuite_books_domain::js::truthy(a.get("importSettings")));
    if parse.format == "csv" && data.csv_format.is_none() && !remembered {
        out.insert(
            "proposal".to_owned(),
            crate::parsers::csv_layout::detect_csv_format(&data.content),
        );
    }
    if let Some(statement) = &parse.account {
        out.insert("account".to_owned(), statement.masked_json());
    }
    if let Some(accounts) = &parse.accounts {
        out.insert(
            "accounts".to_owned(),
            Value::Array(accounts.iter().map(crate::parsers::StatementAccount::masked_json).collect()),
        );
    }
    if let Some(currency) = &parse.currency {
        out.insert("currency".to_owned(), json!(currency));
    }
    if parse.date_range.is_some() {
        out.insert("dateRange".to_owned(), parse.date_range_json());
    }
    if let Some(opening) = optional_number(parse.opening_balance) {
        out.insert("openingBalance".to_owned(), opening);
    }
    if let Some(closing) = optional_number(parse.closing_balance) {
        out.insert("closingBalance".to_owned(), closing);
    }
    out.insert("totalParsed".to_owned(), json!(parse.transactions.len()));
    out.insert("duplicates".to_owned(), json!(duplicates));
    out.insert(
        "problem".to_owned(),
        problem.map_or(Value::Null, |(code, message, details)| {
            json!({ "code": code, "message": message, "details": details })
        }),
    );
    out.insert("errors".to_owned(), parse.errors_json());
    out.insert(
        "sample".to_owned(),
        Value::Array(
            parse
                .transactions
                .iter()
                .take(data.sample_size)
                .map(crate::parsers::Txn::to_json)
                .collect(),
        ),
    );
    Ok(ok(Value::Object(out)))
}

async fn import(caller: Caller, State(state): State<BooksState>, headers: HeaderMap, body: Bytes) -> Response {
    let data = match validate(&headers, &body, |issues, body| read_file_body(issues, body, false)) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond("Failed to import bank file: unknown error"),
    };
    let result = import_file(&caller, &state, data).await;
    result.unwrap_or_else(|refusal| match refusal {
        Refusal::Database(error) => {
            Refusal::Internal(String::new()).respond(&format!("Failed to import bank file: {error}"))
        }
        other => other.respond("Failed to import bank file: unknown error"),
    })
}

#[allow(clippy::too_many_lines)] // mirrors the TypeScript route step by step
async fn import_file(caller: &Caller, state: &BooksState, data: FileBody) -> Reply {
    let account_id = data.bank_account_id.clone().unwrap_or_default();
    let Some(account) = BANK_ACCOUNTS.find_live(&caller.db, &account_id).await? else {
        return Err(Refusal::not_found("Bank account", &account_id));
    };
    let options = ParseOptions {
        file_name: data.file_name.clone(),
        csv_format: csv_format_for(data.csv_format.as_ref(), &account),
        account_last4: text(&account, "accountNumberLast4").map(str::to_owned),
    };
    let parse = match parse_bank_file(&data.content, data.format.as_deref(), &options) {
        Ok(parse) => parse,
        Err(CsvFormatRequired { message, proposal }) => {
            return Ok(error_response(
                StatusCode::UNPROCESSABLE_ENTITY,
                "CSV_FORMAT_REQUIRED",
                &message,
                &json!({ "proposal": proposal }),
            ));
        }
    };
    let problem = file_problem(&parse, &account);
    if let Some((code, message, details)) = &problem
        && !data.ignore_account_mismatch
    {
        return Ok(error_response(StatusCode::CONFLICT, code, message, details));
    }
    let entity_id = text(&account, "entityId").unwrap_or_default().to_owned();
    let batch_id = generate_id("bib");
    let file_name = data.file_name.clone().unwrap_or_default();
    let stamp = now();
    let mut batch = Map::new();
    for (key, value) in [
        ("id", json!(batch_id)),
        ("entityId", json!(entity_id)),
        ("bankAccountId", json!(account_id)),
        ("fileName", json!(file_name)),
        ("format", json!(parse.format)),
        ("totalTransactions", json!(parse.transactions.len())),
        ("importedCount", json!(0)),
        ("duplicateCount", json!(0)),
        ("autoReconciledCount", json!(0)),
        ("status", json!("processing")),
        ("dateRange", parse.date_range_json()),
        ("openingBalance", json!(parse.opening_balance.map(number_text))),
        ("closingBalance", json!(parse.closing_balance.map(number_text))),
        (
            "errors",
            if parse.errors.is_empty() {
                Value::Null
            } else {
                parse.errors_json()
            },
        ),
        ("importedBy", json!(caller.user_id)),
        ("createdAt", json!(stamp)),
        ("updatedAt", json!(stamp)),
    ] {
        BANK_IMPORT_BATCHES.set(&mut batch, key, value);
    }
    BANK_IMPORT_BATCHES.insert_raw(&caller.db, batch).await?;

    let (imported, duplicates) =
        import_transactions(&caller.db, &entity_id, &account_id, &batch_id, &parse.transactions).await?;
    let auto_reconciled = if weldsuite_books_domain::js::truthy(account.get("autoReconcile")) {
        let http = caller.http(state);
        auto_reconcile_batch(&caller.db, http.as_ref(), &account_id, None)
            .await
            .map_or(0, |(count, _)| count)
    } else {
        0
    };
    let status = if imported == 0 {
        "failed"
    } else if parse.errors.is_empty() {
        "completed"
    } else {
        "partial"
    };
    sqlx::query(
        "update bank_import_batches set status = $2, imported_count = $3, duplicate_count = $4, \
         auto_reconciled_count = $5, updated_at = $6::timestamp where id = $1",
    )
    .bind(&batch_id)
    .bind(status)
    .bind(i64::try_from(imported).unwrap_or(i64::MAX))
    .bind(i64::try_from(duplicates).unwrap_or(i64::MAX))
    .bind(i64::try_from(auto_reconciled).unwrap_or(i64::MAX))
    .bind(now())
    .execute(&caller.db)
    .await?;

    let remember = (parse.format == "csv" && data.remember_csv_format)
        .then(|| data.csv_format.clone())
        .flatten();
    if imported > 0 || remember.is_some() {
        let stamp = now();
        let mut set = Map::new();
        set.insert("lastImportDate".to_owned(), json!(stamp));
        set.insert("updatedAt".to_owned(), json!(stamp));
        if imported > 0
            && let Some(closing) = parse.closing_balance
        {
            set.insert("lastImportBalance".to_owned(), json!(number_text(closing)));
            set.insert("currentBalance".to_owned(), json!(number_text(closing)));
        }
        if let Some(layout) = &remember {
            let mut settings = account
                .get("importSettings")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            settings.insert("csv".to_owned(), layout.clone());
            set.insert("importSettings".to_owned(), Value::Object(settings));
        }
        BANK_ACCOUNTS
            .patch_raw(&caller.db, &account_id, BANK_ACCOUNTS.values(&set), false)
            .await?;
        caller.publish(
            state,
            BANK_ACCOUNT_UPDATED,
            &account_id,
            json!({ "id": account_id, "lastImportDate": now(), "importedCount": imported }),
        );
    }
    write_accounting_audit(
        caller,
        &caller.db,
        AuditInput {
            accounting_entity_id: Some(&entity_id),
            entity_type: "bank_import_batch",
            entity_id: &batch_id,
            action: "imported",
            changes: Some(changes(vec![
                ("fileName", Value::Null, json!(file_name)),
                ("format", Value::Null, json!(parse.format)),
                ("totalTransactions", Value::Null, json!(parse.transactions.len())),
                ("importedCount", Value::Null, json!(imported)),
                ("duplicateCount", Value::Null, json!(duplicates)),
                ("autoReconciledCount", Value::Null, json!(auto_reconciled)),
                ("errorCount", Value::Null, json!(parse.errors.len())),
            ])),
        },
    )
    .await;
    Ok(created(json!({
        "batchId": batch_id,
        "format": parse.format,
        "totalParsed": parse.transactions.len(),
        "imported": imported,
        "duplicates": duplicates,
        "autoReconciled": auto_reconciled,
        "errors": parse.errors_json(),
        "dateRange": parse.date_range_json(),
        "closingBalance": parse.closing_balance.map(weldsuite_books_domain::js::number_value),
        "currency": parse.currency,
        "csvFormatRemembered": remember.is_some(),
        "warning": problem.map(|(code, message, _)| json!({ "code": code, "message": message })),
    })))
}

// ── POST /auto-reconcile ────────────────────────────────────────────────────

async fn auto_reconcile(caller: Caller, State(state): State<BooksState>, headers: HeaderMap, body: Bytes) -> Response {
    let account_id = match validate(&headers, &body, |issues, body| {
        issues.text(body, "bankAccountId", Presence::Required, Some(1), None)
    }) {
        Ok(id) => id.into_option().unwrap_or_default(),
        Err(refusal) => return refusal.respond("Failed to auto-reconcile"),
    };
    let result = async {
        let Some(account) = BANK_ACCOUNTS.find_live(&caller.db, &account_id).await? else {
            return Err(Refusal::not_found("Bank account", &account_id));
        };
        let http = caller.http(&state);
        let (count, results) =
            auto_reconcile_batch(&caller.db, http.as_ref(), &account_id, caller.user()).await?;
        write_accounting_audit(
            &caller,
            &caller.db,
            AuditInput {
                accounting_entity_id: text(&account, "entityId"),
                entity_type: "bank_account",
                entity_id: &account_id,
                action: "auto_reconciled",
                changes: Some(changes(vec![("reconciledCount", Value::Null, json!(count))])),
            },
        )
        .await;
        Ok(ok(json!({
            "reconciledCount": count,
            "results": results.iter().map(weldsuite_books_domain::bank_matching::AutoResult::to_json).collect::<Vec<_>>(),
        })))
    }
    .await;
    reply(result, "Failed to auto-reconcile")
}

// ── GET /:id, GET /:id/suggestions ──────────────────────────────────────────

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    let result = async {
        match find_transaction(&caller.db, &id).await? {
            Some(row) => Ok(ok(row)),
            None => Err(Refusal::not_found("Bank transaction", &id)),
        }
    }
    .await;
    reply(result, "Failed to fetch bank transaction")
}

async fn suggestions(caller: Caller, Path(id): Path<String>) -> Response {
    let result = async {
        let Some(txn) = find_transaction(&caller.db, &id).await? else {
            return Err(Refusal::not_found("Transaction", &id));
        };
        let matches = find_matches(&caller.db, &txn, None).await?;
        Ok(ok(Value::Array(
            matches
                .iter()
                .take(10)
                .map(|m| {
                    json!({
                        "type": m.kind,
                        "id": m.entity_id,
                        "number": m.entity_number,
                        "contactName": m.contact_name,
                        "amount": m.amount,
                        "confidence": weldsuite_books_domain::js::number_value(m.confidence),
                        "reasons": m.reasons,
                    })
                })
                .collect(),
        )))
    }
    .await;
    reply(result, "Failed to fetch suggestions")
}

// ── Matching a line ─────────────────────────────────────────────────────────

/// `findLine(c, id)`: the live line of the resolved entity.
async fn find_line(caller: &Caller, id: &str) -> Result<Option<Value>, sqlx::Error> {
    let entity_id = resolve_entity_id(caller).await?;
    let txn = find_transaction(&caller.db, id).await?;
    Ok(txn.filter(|txn| entity_id.as_deref().is_none_or(|entity| text(txn, "entityId") == Some(entity))))
}

/// `recordLinked`: audit trail and events for a line tied to a payment or a
/// deposit.
async fn record_linked(caller: &Caller, state: &BooksState, txn: &Value, payment: bool, linked_id: &str) {
    let mut audit = vec![
        ("status", field(txn, "status"), json!("reconciled")),
        (
            "reconciliationType",
            field(txn, "reconciliationType"),
            json!(if payment { "payment_link" } else { "deposit" }),
        ),
    ];
    audit.push(if payment {
        ("reconciledPaymentId", Value::Null, json!(linked_id))
    } else {
        ("depositId", Value::Null, json!(linked_id))
    });
    let id = text(txn, "id").unwrap_or_default();
    write_accounting_audit(
        caller,
        &caller.db,
        AuditInput {
            accounting_entity_id: text(txn, "entityId"),
            entity_type: "bank_transaction",
            entity_id: id,
            action: "reconciled",
            changes: Some(changes(audit)),
        },
    )
    .await;
    caller.publish(state, BANK_TRANSACTION_UPDATED, id, line_event(txn, "reconciled"));
    caller.publish(
        state,
        if payment { PAYMENT_UPDATED } else { BANK_DEPOSIT_UPDATED },
        linked_id,
        json!({ "id": linked_id, "bankTransactionId": id }),
    );
}

async fn match_deposit(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let deposit_id = match validate(&headers, &body, |issues, body| {
        issues.text(body, "depositId", Presence::Required, Some(1), None)
    }) {
        Ok(id) => id.into_option().unwrap_or_default(),
        Err(refusal) => return refusal.respond("Failed to match the deposit"),
    };
    let result = async {
        let Some(txn) = find_line(&caller, &id).await? else {
            return Err(Refusal::not_found("Transaction", &id));
        };
        let linked = reconcile_to_deposit(&caller.db, &txn, &deposit_id)
            .await
            .map_err(posting_refusal)?;
        record_linked(&caller, &state, &txn, false, &deposit_id).await;
        Ok(ok(json!({
            "id": id,
            "status": "reconciled",
            "depositId": deposit_id,
            "journalEntryId": linked.journal_entry_id,
        })))
    }
    .await;
    reply(result, "Failed to match the deposit")
}

async fn match_payment(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let payment_id = match validate(&headers, &body, |issues, body| {
        issues.text(body, "paymentId", Presence::Required, Some(1), None)
    }) {
        Ok(id) => id.into_option().unwrap_or_default(),
        Err(refusal) => return refusal.respond("Failed to match the payment"),
    };
    let result = async {
        let Some(txn) = find_line(&caller, &id).await? else {
            return Err(Refusal::not_found("Transaction", &id));
        };
        let linked = reconcile_to_payment(&caller.db, &txn, &payment_id)
            .await
            .map_err(posting_refusal)?;
        record_linked(&caller, &state, &txn, true, &payment_id).await;
        Ok(ok(json!({
            "id": id,
            "status": "reconciled",
            "paymentId": payment_id,
            "journalEntryId": linked.journal_entry_id,
        })))
    }
    .await;
    reply(result, "Failed to match the payment")
}

/// `reconcileSchema`.
struct ReconcileBody {
    kind: String,
    entity_id: Option<String>,
    category_account_id: Option<String>,
    tax_rate_id: Option<String>,
    contact_id: Option<String>,
}

async fn reconcile(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, |issues, body| {
        let kind = issues.choice(body, "type", Presence::Required, &["invoice", "bill", "manual"]);
        let mut optional = |key: &str| issues.text(body, key, Presence::Optional, None, None).into_option();
        let entity_id = optional("entityId");
        let category_account_id = optional("categoryAccountId");
        let tax_rate_id = optional("taxRateId");
        let contact_id = optional("contactId");
        ReconcileBody {
            kind: kind.into_option().unwrap_or_default(),
            entity_id,
            category_account_id,
            tax_rate_id,
            contact_id,
        }
    }) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond("Failed to reconcile transaction"),
    };
    reply(
        reconcile_line(&caller, &state, &id, data).await,
        "Failed to reconcile transaction",
    )
}

#[allow(clippy::too_many_lines)] // the two kinds of reconcile, as the worker has them
async fn reconcile_line(caller: &Caller, state: &BooksState, id: &str, data: ReconcileBody) -> Reply {
    let Some(txn) = find_transaction(&caller.db, id).await? else {
        return Err(Refusal::not_found("Transaction", id));
    };
    if data.kind == "manual" {
        let Some(category) = data.category_account_id.as_deref().filter(|c| !c.is_empty()) else {
            return Err(Refusal::bad_request(
                "categoryAccountId is required to categorize a transaction without an invoice or bill",
            ));
        };
        let posted = categorize(
            &caller.db,
            &txn,
            category,
            data.contact_id.as_deref(),
            data.tax_rate_id.as_deref(),
            caller.user(),
        )
        .await
        .map_err(posting_refusal)?;
        write_accounting_audit(
            caller,
            &caller.db,
            AuditInput {
                accounting_entity_id: text(&txn, "entityId"),
                entity_type: "bank_transaction",
                entity_id: id,
                action: "reconciled",
                changes: Some(changes(vec![
                    ("status", field(&txn, "status"), json!("reconciled")),
                    ("reconciliationType", field(&txn, "reconciliationType"), json!("manual")),
                    ("categoryAccountId", field(&txn, "categoryAccountId"), json!(category)),
                    ("journalEntryId", field(&txn, "journalEntryId"), json!(posted.journal_entry_id)),
                ])),
            },
        )
        .await;
        caller.publish(state, BANK_TRANSACTION_UPDATED, id, line_event(&txn, "reconciled"));
        caller.publish(
            state,
            JOURNAL_ENTRY_CREATED,
            &posted.journal_entry_id,
            json!({ "id": posted.journal_entry_id, "sourceType": "bank_transaction", "sourceId": id }),
        );
        return Ok(ok(json!({
            "id": id,
            "status": "reconciled",
            "journalEntryId": posted.journal_entry_id,
        })));
    }
    let Some(document_id) = data.entity_id.as_deref().filter(|d| !d.is_empty()) else {
        return Err(Refusal::bad_request(
            "entityId (the invoice or bill id) is required",
        ));
    };
    let invoice = data.kind == "invoice";
    let http = caller.http(state);
    let matched = reconcile_to_document(
        &caller.db,
        http.as_ref(),
        &txn,
        invoice,
        document_id,
        None,
        caller.user().map(str::to_owned),
    )
    .await
    .map_err(posting_refusal)?;
    let mut audit = vec![
        ("status", field(&txn, "status"), json!("reconciled")),
        ("reconciliationType", field(&txn, "reconciliationType"), json!("manual")),
        ("reconciledPaymentId", field(&txn, "reconciledPaymentId"), json!(matched.id)),
    ];
    if invoice {
        audit.push(("reconciledInvoiceId", field(&txn, "reconciledInvoiceId"), json!(document_id)));
    } else {
        audit.push(("reconciledBillId", field(&txn, "reconciledBillId"), json!(document_id)));
    }
    write_accounting_audit(
        caller,
        &caller.db,
        AuditInput {
            accounting_entity_id: text(&txn, "entityId"),
            entity_type: "bank_transaction",
            entity_id: id,
            action: "reconciled",
            changes: Some(changes(audit)),
        },
    )
    .await;
    caller.publish(state, BANK_TRANSACTION_UPDATED, id, line_event(&txn, "reconciled"));
    let mut payment = Map::new();
    payment.insert("id".to_owned(), json!(matched.id));
    payment.insert(
        "amount".to_owned(),
        json!(number_text(js_number_value(txn.get("amount")).abs())),
    );
    payment.insert(if invoice { "invoiceId" } else { "billId" }.to_owned(), json!(document_id));
    caller.publish(state, PAYMENT_CREATED, &matched.id, Value::Object(payment));
    Ok(ok(json!({
        "id": id,
        "status": "reconciled",
        "paymentId": matched.id,
        "journalEntryId": matched.journal_entry_id,
    })))
}

// ── POST /:id/unreconcile, POST /:id/exclude ────────────────────────────────

async fn unreconcile_line(caller: Caller, State(state): State<BooksState>, Path(id): Path<String>) -> Response {
    let result = async {
        let Some(txn) = find_transaction(&caller.db, &id).await? else {
            return Err(Refusal::not_found("Transaction", &id));
        };
        unreconcile(&caller.db, &txn, caller.user().map(str::to_owned))
            .await
            .map_err(posting_refusal)?;
        write_accounting_audit(
            &caller,
            &caller.db,
            AuditInput {
                accounting_entity_id: text(&txn, "entityId"),
                entity_type: "bank_transaction",
                entity_id: &id,
                action: "unreconciled",
                changes: Some(changes(vec![
                    ("status", field(&txn, "status"), json!("unreconciled")),
                    ("reconciledPaymentId", field(&txn, "reconciledPaymentId"), Value::Null),
                    ("journalEntryId", field(&txn, "journalEntryId"), Value::Null),
                ])),
            },
        )
        .await;
        caller.publish(&state, BANK_TRANSACTION_UPDATED, &id, line_event(&txn, "unreconciled"));
        Ok(ok(json!({ "id": id, "status": "unreconciled" })))
    }
    .await;
    reply(result, "Failed to unreconcile transaction")
}

async fn exclude(caller: Caller, State(state): State<BooksState>, Path(id): Path<String>) -> Response {
    let result = async {
        let Some(txn) = find_transaction(&caller.db, &id).await? else {
            return Err(Refusal::not_found("Transaction", &id));
        };
        sqlx::query("update bank_transactions set status = 'excluded', updated_at = $2::timestamp where id = $1")
            .bind(&id)
            .bind(now())
            .execute(&caller.db)
            .await?;
        write_accounting_audit(
            &caller,
            &caller.db,
            AuditInput {
                accounting_entity_id: text(&txn, "entityId"),
                entity_type: "bank_transaction",
                entity_id: &id,
                action: "excluded",
                changes: Some(changes(vec![("status", field(&txn, "status"), json!("excluded"))])),
            },
        )
        .await;
        caller.publish(&state, BANK_TRANSACTION_UPDATED, &id, line_event(&txn, "excluded"));
        Ok(ok(json!({ "message": "Transaction excluded" })))
    }
    .await;
    reply(result, "Failed to exclude transaction")
}
