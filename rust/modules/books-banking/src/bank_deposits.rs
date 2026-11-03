//! `/api/bank-deposits` (`routes/bank-deposits/index.ts`,
//! `services/accounting-bank-deposits.ts`): checks and cash waiting in
//! Undeposited Funds taken to the bank as one deposit — one entry that
//! debits the bank for the slip's total and credits Undeposited Funds per
//! payment (plus other lines such as cash back) — and voiding it.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::Response;
use axum::routing::{delete, get, patch, post};
use http::HeaderMap;
use serde_json::{Map, Value, json};
use sqlx::PgPool;
use weldsuite_books_domain::document_posting::load_entity;
use weldsuite_books_domain::entity_context::resolve_entity_id;
use weldsuite_books_domain::guards::{AuditInput, PostingLockKind, write_accounting_audit};
use weldsuite_books_domain::http::{
    BooksState, Caller, Refusal, all_rows, created, no_content, now, ok, paged, reply, validate,
};
use weldsuite_books_domain::js::{js_number_value, number_value, parse_int, round_money, to_fixed};
use weldsuite_books_domain::posting::{
    AlsoWrite, PostError, PostJournalEntryInput, PostingLine, ReverseArgs, account_for_role,
    load_entity_accounts, post_journal_entry, reverse_journal_entry,
};
use weldsuite_books_domain::tables::{BANK_ACCOUNTS, BANK_DEPOSITS, PAYMENTS};
use weldsuite_catalogs::entity_events::{
    BANK_DEPOSIT_CREATED, BANK_DEPOSIT_DELETED, BANK_DEPOSIT_UPDATED,
};
use weldsuite_kit::cursor::{atob_url, btoa_url};
use weldsuite_kit::generate_id;
use weldsuite_kit::validation::{Field, Issues, Number, Presence, Text};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use crate::common::{changes, field, posting_refusal, text};

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
            "/undeposited",
            get(undeposited).route_layer(need("banking:read")),
        )
        .route("/{id}", get(detail).route_layer(need("banking:read")))
        .route("/{id}", patch(update).route_layer(need("banking:update")))
        .route("/{id}", delete(void).route_layer(need("banking:update")))
        .with_state(state)
}

fn posting(message: impl Into<String>) -> PostError {
    PostError::Posting(message.into())
}

// ── Undeposited Funds ───────────────────────────────────────────────────────

/// `UndepositedPayment`.
struct Undeposited {
    payment: Value,
    /// What sits in Undeposited Funds for it, in the base currency.
    amount: f64,
    contact_name: Option<String>,
}

impl Undeposited {
    fn to_json(&self) -> Value {
        json!({
            "paymentId": field(&self.payment, "id"),
            "date": field(&self.payment, "date"),
            "paymentMethod": field(&self.payment, "paymentMethod"),
            "checkNumber": field(&self.payment, "checkNumber"),
            "reference": field(&self.payment, "reference"),
            "currency": field(&self.payment, "currency"),
            "paymentAmount": field(&self.payment, "amount"),
            "amount": number_value(self.amount),
            "contactId": field(&self.payment, "contactId"),
            "contactName": self.contact_name,
            "journalEntryId": field(&self.payment, "journalEntryId"),
        })
    }

    fn text(&self, key: &str) -> Option<&str> {
        text(&self.payment, key)
    }
}

/// `listUndepositedPayments(db, entityId)`.
async fn list_undeposited(db: &PgPool, entity_id: &str) -> Result<Vec<Undeposited>, sqlx::Error> {
    let accounts = load_entity_accounts(db, entity_id).await?;
    let Some(undeposited) = account_for_role(&accounts, "undeposited_funds", &[]) else {
        return Ok(Vec::new());
    };
    let rows: Vec<(Value, Option<String>, Option<String>)> = sqlx::query_as(concat!(
        "select ",
        weldsuite_books_domain::books_row!(payments),
        ", sum(coalesce(jl.debit, 0) - coalesce(jl.credit, 0))::text, p.display_name \
         from payments t \
         inner join journal_lines jl on jl.journal_entry_id = t.journal_entry_id and jl.account_id = $2 \
           and jl.deleted_at is null \
         left join parties p on p.id = t.contact_id \
         where t.entity_id = $1 and t.type = 'received' and t.deleted_at is null and t.deposit_id is null \
         group by t.id, p.display_name order by t.date, t.created_at"
    ))
    .bind(entity_id)
    .bind(text(undeposited, "id"))
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .filter_map(|(row, amount, contact_name)| {
            let amount = js_number_value(amount.map(Value::String).as_ref());
            (amount > 0.0).then(|| Undeposited {
                payment: PAYMENTS.js(row),
                amount: round_money(amount),
                contact_name,
            })
        })
        .collect())
}

async fn undeposited(caller: Caller) -> Response {
    let result = async {
        let Some(entity_id) = resolve_entity_id(&caller).await? else {
            return Ok(all_rows(Vec::new()));
        };
        let rows = list_undeposited(&caller.db, &entity_id).await?;
        Ok(all_rows(rows.iter().map(Undeposited::to_json).collect()))
    }
    .await;
    reply(result, "Failed to fetch undeposited payments")
}

// ── GET / ───────────────────────────────────────────────────────────────────

/// `decodeCursor`: `date|id` from base64url, the date `YYYY-MM-DD`.
fn decode_cursor(cursor: &str) -> Option<(String, String)> {
    let decoded = atob_url(cursor)?;
    let mut parts = decoded.split('|');
    let date = parts.next().filter(|d| !d.is_empty())?;
    let id = parts.next().filter(|i| !i.is_empty())?;
    let b = date.as_bytes();
    let shaped = b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && [0, 1, 2, 3, 5, 6, 8, 9]
            .iter()
            .all(|i| b[*i].is_ascii_digit());
    shaped.then(|| (date.to_owned(), id.to_owned()))
}

async fn list(caller: Caller) -> Response {
    let result = async {
        let Some(entity_id) = resolve_entity_id(&caller).await? else {
            return Ok(paged(Vec::new(), 0, false, None));
        };
        let q = caller.query();
        let limit = parse_int(q.present("limit").unwrap_or("25"))
            .filter(|n| *n != 0)
            .unwrap_or(25)
            .clamp(1, 100);
        let after = match q.present("cursor") {
            Some(cursor) => match decode_cursor(cursor) {
                Some(after) => Some(after),
                None => return Err(Refusal::bad_request("Invalid cursor")),
            },
            None => None,
        };
        let (after_date, after_id) = after.unzip();
        let filters = (
            q.present("bankAccountId"),
            q.present("status"),
            q.present("from"),
            q.present("to"),
        );
        let rows: Vec<Value> = sqlx::query_scalar(concat!(
            "select ",
            weldsuite_books_domain::books_row!(bank_deposits),
            " from bank_deposits t where t.entity_id = $1 and t.deleted_at is null \
             and ($2::text is null or t.bank_account_id = $2) and ($3::text is null or t.status = $3) \
             and ($4::text is null or t.date >= $4::date) and ($5::text is null or t.date <= $5::date) \
             and ($6::text is null or t.date < $6::date or (t.date = $6::date and t.id < $7)) \
             order by t.date desc, t.id desc limit $8"
        ))
        .bind(&entity_id)
        .bind(filters.0)
        .bind(filters.1)
        .bind(filters.2)
        .bind(filters.3)
        .bind(after_date.as_deref())
        .bind(after_id.as_deref())
        .bind(limit + 1)
        .fetch_all(&caller.db)
        .await?;
        let total: i64 = sqlx::query_scalar(
            "select count(*)::int8 from bank_deposits t where t.entity_id = $1 and t.deleted_at is null \
             and ($2::text is null or t.bank_account_id = $2) and ($3::text is null or t.status = $3) \
             and ($4::text is null or t.date >= $4::date) and ($5::text is null or t.date <= $5::date)",
        )
        .bind(&entity_id)
        .bind(filters.0)
        .bind(filters.1)
        .bind(filters.2)
        .bind(filters.3)
        .fetch_one(&caller.db)
        .await?;
        let mut rows = BANK_DEPOSITS.js_rows(rows);
        let has_more = i64::try_from(rows.len()).unwrap_or(i64::MAX) > limit;
        if has_more {
            rows.truncate(usize::try_from(limit).unwrap_or(0));
        }
        let cursor = if has_more {
            rows.last().and_then(|last| {
                btoa_url(&format!(
                    "{}|{}",
                    text(last, "date").unwrap_or_default(),
                    text(last, "id").unwrap_or_default()
                ))
            })
        } else {
            None
        };
        Ok(paged(rows, total, has_more, cursor))
    }
    .await;
    reply(result, "Failed to fetch bank deposits")
}

// ── GET /:id ────────────────────────────────────────────────────────────────

async fn find_deposit(
    caller: &Caller,
    entity_id: &str,
    id: &str,
) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(bank_deposits),
        " from bank_deposits t where t.id = $1 and t.entity_id = $2 and t.deleted_at is null limit 1"
    ))
    .bind(id)
    .bind(entity_id)
    .fetch_optional(&caller.db)
    .await?;
    Ok(row.map(|row| BANK_DEPOSITS.js(row)))
}

/// `loadDepositDetail(db, deposit)`: the deposit with its payments, other
/// lines (account code and name) and bank account and entry.
async fn deposit_detail(db: &PgPool, deposit: &Value) -> Result<Value, sqlx::Error> {
    let id = text(deposit, "id").unwrap_or_default();
    let payments: Vec<(Value, Option<String>)> = sqlx::query_as(concat!(
        "select ",
        weldsuite_books_domain::books_row!(payments),
        ", p.display_name from payments t left join parties p on p.id = t.contact_id \
         where t.deposit_id = $1 and t.deleted_at is null order by t.date"
    ))
    .bind(id)
    .fetch_all(db)
    .await?;
    let payments: Vec<Value> = payments
        .into_iter()
        .map(|(row, name)| {
            let row = PAYMENTS.js(row);
            json!({
                "id": field(&row, "id"),
                "date": field(&row, "date"),
                "amount": field(&row, "amount"),
                "currency": field(&row, "currency"),
                "paymentMethod": field(&row, "paymentMethod"),
                "checkNumber": field(&row, "checkNumber"),
                "reference": field(&row, "reference"),
                "contactId": field(&row, "contactId"),
                "contactName": name,
                "invoiceId": field(&row, "invoiceId"),
            })
        })
        .collect();
    let bank_name: Option<Option<String>> =
        sqlx::query_scalar("select name from bank_accounts where id = $1 limit 1")
            .bind(text(deposit, "bankAccountId"))
            .fetch_optional(db)
            .await?;
    let entry_number: Option<Option<String>> =
        match text(deposit, "journalEntryId").filter(|e| !e.is_empty()) {
            Some(entry) => {
                sqlx::query_scalar("select entry_number from journal_entries where id = $1 limit 1")
                    .bind(entry)
                    .fetch_optional(db)
                    .await?
            }
            None => None,
        };
    let lines: Vec<Value> = deposit
        .get("otherLines")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let ids: Vec<String> = lines
        .iter()
        .filter_map(|l| {
            l.get("accountId")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .collect();
    let accounts: Vec<(String, String, String)> = if ids.is_empty() {
        Vec::new()
    } else {
        sqlx::query_as("select id, code, name from accounts where id = any($1)")
            .bind(&ids)
            .fetch_all(db)
            .await?
    };
    let other_lines: Vec<Value> = lines
        .into_iter()
        .map(|mut line| {
            let account = line
                .get("accountId")
                .and_then(Value::as_str)
                .and_then(|id| accounts.iter().find(|(a, _, _)| a == id))
                .cloned();
            if let Value::Object(map) = &mut line {
                map.insert(
                    "accountCode".to_owned(),
                    json!(account.as_ref().map(|a| &a.1)),
                );
                map.insert(
                    "accountName".to_owned(),
                    json!(account.as_ref().map(|a| &a.2)),
                );
            }
            line
        })
        .collect();
    let mut out = deposit.as_object().cloned().unwrap_or_default();
    out.insert("bankAccountName".to_owned(), json!(bank_name.flatten()));
    out.insert(
        "journalEntryNumber".to_owned(),
        json!(entry_number.flatten()),
    );
    out.insert("payments".to_owned(), Value::Array(payments));
    out.insert("otherLines".to_owned(), Value::Array(other_lines));
    Ok(Value::Object(out))
}

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    let result = async {
        let Some(entity_id) = resolve_entity_id(&caller).await? else {
            return Err(Refusal::bad_request("No accounting entity resolved"));
        };
        let Some(deposit) = find_deposit(&caller, &entity_id, &id).await? else {
            return Err(Refusal::not_found("Bank deposit", &id));
        };
        Ok(ok(deposit_detail(&caller.db, &deposit).await?))
    }
    .await;
    reply(result, "Failed to fetch bank deposit")
}

// ── POST / ──────────────────────────────────────────────────────────────────

struct OtherLine {
    account_id: String,
    amount: f64,
    description: Option<String>,
    /// The line as the body gave it (`{ accountId, amount, description? }`).
    raw: Value,
}

struct CreateBody {
    bank_account_id: String,
    date: String,
    payment_ids: Vec<String>,
    other_lines: Option<Vec<OtherLine>>,
    memo: Option<String>,
}

/// `/^\d{4}-\d{2}-\d{2}/`
fn day_prefix(value: &str) -> bool {
    let b = value.as_bytes();
    b.len() >= 10
        && b[4] == b'-'
        && b[7] == b'-'
        && [0, 1, 2, 3, 5, 6, 8, 9]
            .iter()
            .all(|i| b[*i].is_ascii_digit())
}

fn read_create(issues: &mut Issues, body: &Map<String, Value>) -> Option<CreateBody> {
    let account = issues.text(body, "bankAccountId", Presence::Required, Some(1), Some(30));
    let date = issues.pattern(
        body,
        "date",
        Presence::Required,
        None,
        None,
        day_prefix,
        "Use a YYYY-MM-DD date",
    );
    let payment_ids = issues.list(
        body,
        "paymentIds",
        Presence::Optional,
        None,
        Some(500),
        |issues, item| issues.item_text(item, Text::length(Some(1), Some(30))),
    );
    let other_lines = issues.list(
        body,
        "otherLines",
        Presence::Optional,
        None,
        Some(50),
        |issues, item| {
            let fields = issues.object(item)?;
            let start = issues.count();
            let account_id =
                issues.text(fields, "accountId", Presence::Required, Some(1), Some(30));
            let amount = issues.number(fields, "amount", Presence::Required, Number::default());
            let description =
                issues.text(fields, "description", Presence::Optional, None, Some(255));
            if issues.count() > start {
                return None;
            }
            let mut raw = Map::new();
            raw.insert(
                "accountId".to_owned(),
                fields.get("accountId").cloned().unwrap_or(Value::Null),
            );
            raw.insert(
                "amount".to_owned(),
                fields.get("amount").cloned().unwrap_or(Value::Null),
            );
            if let Some(d) = fields.get("description") {
                raw.insert("description".to_owned(), d.clone());
            }
            Some(OtherLine {
                account_id: account_id.into_option()?,
                amount: amount.into_option()?,
                description: description.into_option(),
                raw: Value::Object(raw),
            })
        },
    );
    let memo = issues.text(body, "memo", Presence::Optional, None, Some(500));
    Some(CreateBody {
        bank_account_id: account.into_option()?,
        date: date.into_option()?,
        payment_ids: match payment_ids {
            Field::Set(ids) => ids,
            _ => Vec::new(),
        },
        other_lines: other_lines.into_option(),
        memo: memo.into_option(),
    })
}

/// `createDeposit(db, input)`. (`!(x > 0)` keeps JavaScript's NaN handling.)
#[allow(clippy::too_many_lines, clippy::neg_cmp_op_on_partial_ord)] // the worker's steps, in its order
async fn create_deposit(
    db: &PgPool,
    entity_id: &str,
    data: &CreateBody,
    user_id: Option<&str>,
) -> Result<(String, Option<String>, f64), PostError> {
    let accounts = load_entity_accounts(db, entity_id).await?;
    let Some(undeposited) = account_for_role(&accounts, "undeposited_funds", &[]) else {
        return Err(posting(
            "This accounting entity has no Undeposited Funds account",
        ));
    };
    let undeposited_id = text(undeposited, "id").unwrap_or_default().to_owned();
    let bank: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(bank_accounts),
        " from bank_accounts t where t.id = $1 and t.entity_id = $2 and t.deleted_at is null limit 1"
    ))
    .bind(&data.bank_account_id)
    .bind(entity_id)
    .fetch_optional(db)
    .await?;
    let Some(bank) = bank.map(|row| BANK_ACCOUNTS.js(row)) else {
        return Err(posting("Bank account not found for this accounting entity"));
    };
    let Some(ledger) = accounts.by_id(text(&bank, "ledgerAccountId")) else {
        return Err(posting(
            "This bank account is not linked to a ledger account. Edit the bank account and choose a GL account first.",
        ));
    };
    if text(ledger, "type") != Some("asset") {
        return Err(posting(
            "Deposits go to a checking, savings or money market account",
        ));
    }
    let ledger_id = text(ledger, "id").unwrap_or_default().to_owned();
    let entity = load_entity(db, entity_id).await?;
    let base = text(&entity, "baseCurrency").unwrap_or_default().to_owned();
    if let Some(currency) = text(&bank, "currency").filter(|c| !c.is_empty())
        && currency != base
    {
        return Err(posting(format!(
            "Deposits into a {currency} bank account aren't supported on a {base} entity"
        )));
    }
    let mut payment_ids: Vec<&String> = Vec::new();
    for id in &data.payment_ids {
        if !payment_ids.contains(&id) {
            payment_ids.push(id);
        }
    }
    let other_lines: &[OtherLine] = data.other_lines.as_deref().unwrap_or_default();
    if payment_ids.is_empty() && other_lines.is_empty() {
        return Err(posting("Pick at least one payment to deposit"));
    }
    let candidates = list_undeposited(db, entity_id).await?;
    let mut chosen: Vec<&Undeposited> = Vec::new();
    for id in &payment_ids {
        let Some(found) = candidates
            .iter()
            .find(|c| c.text("id") == Some(id.as_str()))
        else {
            return Err(posting(format!(
                "Payment {id} is not waiting in Undeposited Funds (already deposited, voided, or paid into a bank account)"
            )));
        };
        chosen.push(found);
    }
    for line in other_lines {
        if !(line.amount.abs() > 0.0) {
            return Err(posting("Other deposit lines need a non-zero amount"));
        }
        let Some(account) = accounts.by_id(Some(&line.account_id)) else {
            return Err(posting(format!(
                "Account {} does not belong to this accounting entity",
                line.account_id
            )));
        };
        let account_id = text(account, "id").unwrap_or_default();
        if account_id == undeposited_id || account_id == ledger_id {
            return Err(posting(
                "Other deposit lines go to an income, expense or other account, not to Undeposited Funds or the bank itself",
            ));
        }
    }
    let payments_total = round_money(chosen.iter().fold(0.0, |sum, p| sum + p.amount));
    let total = round_money(
        other_lines
            .iter()
            .fold(payments_total, |sum, l| sum + l.amount),
    );
    if !(total > 0.0) {
        return Err(posting("The deposit total must be greater than zero"));
    }

    let deposit_id = generate_id("dep");
    let memo = data
        .memo
        .as_deref()
        .map(weldsuite_books_domain::jurisdictions::js_trim)
        .filter(|m| !m.is_empty())
        .map(str::to_owned);
    let line = |account_id: &str,
                debit: f64,
                credit: f64,
                description: String,
                contact: Option<String>| PostingLine {
        account_id: account_id.to_owned(),
        debit,
        credit,
        description: Some(description),
        contact_id: contact,
        currency: Some(base.clone()),
        ..PostingLine::default()
    };
    let mut lines = vec![line(
        &ledger_id,
        total,
        0.0,
        memo.as_ref()
            .map_or_else(|| "Deposit".to_owned(), |m| format!("Deposit: {m}")),
        None,
    )];
    for p in &chosen {
        let what = match p.text("checkNumber").filter(|c| !c.is_empty()) {
            Some(check) => format!("check {check}"),
            None => p.text("paymentMethod").unwrap_or("payment").to_owned(),
        };
        let from = p
            .contact_name
            .as_deref()
            .filter(|n| !n.is_empty())
            .map(|n| format!(" from {n}"))
            .unwrap_or_default();
        lines.push(line(
            &undeposited_id,
            0.0,
            p.amount,
            format!("Deposit of {what}{from}"),
            p.text("contactId").map(str::to_owned),
        ));
    }
    for l in other_lines {
        let description = l.description.clone().unwrap_or_else(|| {
            if l.amount > 0.0 {
                "Deposit: other income"
            } else {
                "Deposit: cash back"
            }
            .to_owned()
        });
        lines.push(if l.amount > 0.0 {
            line(&l.account_id, 0.0, l.amount, description, None)
        } else {
            line(&l.account_id, -l.amount, 0.0, description, None)
        });
    }

    let stamp = now();
    let mut row = Map::new();
    for (key, value) in [
        ("id", json!(deposit_id)),
        ("entityId", json!(entity_id)),
        ("bankAccountId", field(&bank, "id")),
        (
            "date",
            json!(data.date.chars().take(10).collect::<String>()),
        ),
        ("amount", json!(to_fixed(total, 2))),
        ("currency", json!(base)),
        ("memo", json!(memo)),
        (
            "otherLines",
            if other_lines.is_empty() {
                Value::Null
            } else {
                Value::Array(other_lines.iter().map(|l| l.raw.clone()).collect())
            },
        ),
        ("status", json!("posted")),
        ("createdBy", json!(user_id)),
        ("createdAt", json!(stamp)),
        ("updatedAt", json!(stamp)),
    ] {
        BANK_DEPOSITS.set(&mut row, key, value);
    }
    let ids: Vec<String> = payment_ids.iter().map(|id| (*id).clone()).collect();
    let has_payments = !chosen.is_empty();
    let deposit_key = deposit_id.clone();
    let write: AlsoWrite = Box::new(move |conn, posted| {
        Box::pin(async move {
            row.insert(
                "journal_entry_id".to_owned(),
                json!(posted.journal_entry_id),
            );
            BANK_DEPOSITS.insert_raw(&mut *conn, row).await?;
            if has_payments {
                sqlx::query(
                    "update payments set deposit_id = $1, updated_at = $3::timestamp \
                     where id = any($2) and deposit_id is null",
                )
                .bind(&deposit_key)
                .bind(&ids)
                .bind(&stamp)
                .execute(&mut *conn)
                .await?;
            }
            Ok(())
        })
    });
    let entry_date = format!(
        "{}T00:00:00.000Z",
        data.date.chars().take(10).collect::<String>()
    );
    let posted = post_journal_entry(
        db,
        PostJournalEntryInput {
            entity_id: entity_id.to_owned(),
            date: entry_date,
            description: memo.as_ref().map_or_else(
                || "Bank deposit".to_owned(),
                |m| format!("Bank deposit — {m}"),
            ),
            source_type: "bank_deposit".to_owned(),
            source_id: Some(deposit_id.clone()),
            posting_key: Some(format!("bank_deposit:{deposit_id}:post")),
            lock_kind: Some(PostingLockKind::General),
            lines,
            created_by: user_id.map(str::to_owned),
            also_write: vec![write],
            ..PostJournalEntryInput::default()
        },
    )
    .await?;
    Ok((deposit_id, posted.journal_entry_id, total))
}

async fn create(
    caller: Caller,
    State(state): State<BooksState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let data = match validate(&headers, &body, read_create) {
        Ok(Some(data)) => data,
        Ok(None) => {
            return Refusal::Internal("unread body".to_owned())
                .respond("Failed to create bank deposit");
        }
        Err(refusal) => return refusal.respond("Failed to create bank deposit"),
    };
    let result = async {
        let Some(entity_id) = resolve_entity_id(&caller).await? else {
            return Err(Refusal::bad_request("No accounting entity resolved"));
        };
        let (deposit_id, journal_entry_id, total) =
            create_deposit(&caller.db, &entity_id, &data, caller.user())
                .await
                .map_err(posting_refusal)?;
        let amount = to_fixed(total, 2);
        write_accounting_audit(
            &caller,
            &caller.db,
            AuditInput {
                accounting_entity_id: Some(&entity_id),
                entity_type: "bank_deposit",
                entity_id: &deposit_id,
                action: "created",
                changes: Some(changes(vec![
                    ("bankAccountId", Value::Null, json!(data.bank_account_id)),
                    ("amount", Value::Null, json!(amount)),
                    ("paymentCount", Value::Null, json!(data.payment_ids.len())),
                    ("journalEntryId", Value::Null, json!(journal_entry_id)),
                ])),
            },
        )
        .await;
        caller.publish(
            &state,
            BANK_DEPOSIT_CREATED,
            &deposit_id,
            json!({
                "id": deposit_id,
                "bankAccountId": data.bank_account_id,
                "date": data.date,
                "amount": amount,
                "paymentCount": data.payment_ids.len(),
            }),
        );
        Ok(created(
            json!({ "id": deposit_id, "journalEntryId": journal_entry_id, "amount": amount }),
        ))
    }
    .await;
    reply(result, "Failed to create bank deposit")
}

// ── PATCH /:id ──────────────────────────────────────────────────────────────

async fn update(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let memo = match validate(&headers, &body, |issues, body| {
        issues.text(body, "memo", Presence::Nullable, None, Some(500))
    }) {
        Ok(memo) => memo.into_option(),
        Err(refusal) => return refusal.respond("Failed to update bank deposit"),
    };
    let result = async {
        let Some(entity_id) = resolve_entity_id(&caller).await? else {
            return Err(Refusal::bad_request("No accounting entity resolved"));
        };
        let Some(deposit) = find_deposit(&caller, &entity_id, &id).await? else {
            return Err(Refusal::not_found("Bank deposit", &id));
        };
        let memo = memo
            .as_deref()
            .map(weldsuite_books_domain::jurisdictions::js_trim)
            .filter(|m| !m.is_empty())
            .map(str::to_owned);
        sqlx::query("update bank_deposits set memo = $2, updated_at = $3::timestamp where id = $1")
            .bind(&id)
            .bind(&memo)
            .bind(now())
            .execute(&caller.db)
            .await?;
        write_accounting_audit(
            &caller,
            &caller.db,
            AuditInput {
                accounting_entity_id: Some(&entity_id),
                entity_type: "bank_deposit",
                entity_id: &id,
                action: "updated",
                changes: Some(changes(vec![(
                    "memo",
                    field(&deposit, "memo"),
                    json!(memo),
                )])),
            },
        )
        .await;
        caller.publish(
            &state,
            BANK_DEPOSIT_UPDATED,
            &id,
            json!({
                "id": id,
                "bankAccountId": field(&deposit, "bankAccountId"),
                "amount": field(&deposit, "amount"),
                "memo": memo,
            }),
        );
        let mut out = deposit.as_object().cloned().unwrap_or_default();
        out.insert("memo".to_owned(), json!(memo));
        Ok(ok(Value::Object(out)))
    }
    .await;
    reply(result, "Failed to update bank deposit")
}

// ── DELETE /:id ─────────────────────────────────────────────────────────────

/// The void's statements: the deposit void, its payments back in
/// Undeposited Funds, its bank line released.
async fn release(conn: &mut sqlx::PgConnection, id: &str, stamp: &str) -> Result<(), sqlx::Error> {
    sqlx::query(
        "update bank_deposits set status = 'void', updated_at = $2::timestamp where id = $1",
    )
    .bind(id)
    .bind(stamp)
    .execute(&mut *conn)
    .await?;
    sqlx::query(
        "update payments set deposit_id = null, updated_at = $2::timestamp where deposit_id = $1",
    )
    .bind(id)
    .bind(stamp)
    .execute(&mut *conn)
    .await?;
    sqlx::query(
        "update bank_transactions set status = 'unreconciled', reconciliation_type = null, deposit_id = null, \n         journal_entry_id = null, updated_at = $2::timestamp where deposit_id = $1",
    )
    .bind(id)
    .bind(stamp)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// `voidDeposit`: reverse the entry (dated today), put the payments back in
/// Undeposited Funds and release the bank line, atomically.
#[allow(clippy::single_match_else)]
async fn void_deposit(
    db: &PgPool,
    entity_id: &str,
    id: &str,
    user_id: Option<&str>,
) -> Result<Value, PostError> {
    let deposit: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(bank_deposits),
        " from bank_deposits t where t.id = $1 and t.entity_id = $2 and t.deleted_at is null limit 1"
    ))
    .bind(id)
    .bind(entity_id)
    .fetch_optional(db)
    .await?;
    let Some(deposit) = deposit.map(|row| BANK_DEPOSITS.js(row)) else {
        return Err(posting("Deposit not found"));
    };
    if text(&deposit, "status") == Some("void") {
        return Err(posting("This deposit has already been voided"));
    }
    let stamp = now();
    match text(&deposit, "journalEntryId").filter(|e| !e.is_empty()) {
        Some(entry) => {
            let memo = text(&deposit, "memo")
                .filter(|m| !m.is_empty())
                .map(|m| format!(" — {m}"))
                .unwrap_or_default();
            let deposit_id = id.to_owned();
            let at = stamp.clone();
            let write: AlsoWrite = Box::new(move |conn, _| {
                Box::pin(async move { release(conn, &deposit_id, &at).await })
            });
            reverse_journal_entry(
                db,
                ReverseArgs {
                    entry_id: entry.to_owned(),
                    date: stamp,
                    created_by: user_id.map(str::to_owned),
                    description: Some(format!("Void bank deposit{memo}")),
                    also_write: vec![write],
                    ..ReverseArgs::default()
                },
            )
            .await?;
        }
        None => {
            let mut tx = db.begin().await?;
            release(&mut tx, id, &stamp).await?;
            tx.commit().await?;
        }
    }
    Ok(deposit)
}

async fn void(caller: Caller, State(state): State<BooksState>, Path(id): Path<String>) -> Response {
    let result = async {
        let Some(entity_id) = resolve_entity_id(&caller).await? else {
            return Err(Refusal::bad_request("No accounting entity resolved"));
        };
        let deposit = match void_deposit(&caller.db, &entity_id, &id, caller.user()).await {
            Ok(deposit) => deposit,
            Err(PostError::Posting(message)) if message == "Deposit not found" => {
                return Err(Refusal::not_found("Bank deposit", &id));
            }
            Err(error) => return Err(posting_refusal(error)),
        };
        write_accounting_audit(
            &caller,
            &caller.db,
            AuditInput {
                accounting_entity_id: Some(&entity_id),
                entity_type: "bank_deposit",
                entity_id: &id,
                action: "voided",
                changes: Some(changes(vec![(
                    "status",
                    field(&deposit, "status"),
                    json!("void"),
                )])),
            },
        )
        .await;
        caller.publish(
            &state,
            BANK_DEPOSIT_DELETED,
            &id,
            json!({
                "id": id,
                "bankAccountId": field(&deposit, "bankAccountId"),
                "amount": field(&deposit, "amount"),
            }),
        );
        Ok(no_content())
    }
    .await;
    reply(result, "Failed to void bank deposit")
}
