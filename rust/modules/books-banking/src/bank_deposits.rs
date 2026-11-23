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
use sea_orm::prelude::BigDecimal;
use sea_orm::sea_query::{Expr, Func};
use sea_orm::{
    ColumnTrait, Condition, ConnectionTrait, DbErr, EntityTrait, FromQueryResult, JoinType,
    PaginatorTrait, QueryFilter, QueryOrder, QuerySelect, QueryTrait, RelationDef,
};
use serde_json::{Map, Value, json};
use sqlx::PgPool;
use time::{OffsetDateTime, PrimitiveDateTime};
use weldsuite_books_domain::document_posting::load_entity;
use weldsuite_books_domain::entity_context::resolve_entity_id;
use weldsuite_books_domain::guards::{AuditInput, PostingLockKind, write_accounting_audit};
use weldsuite_books_domain::http::{
    BooksState, Caller, Refusal, all_rows, created, no_content, ok, paged, reply, validate,
};
use weldsuite_books_domain::js::{js_number_value, number_value, parse_int, round_money, to_fixed};
use weldsuite_books_domain::posting::{
    AlsoWrite, PostError, PostJournalEntryInput, PostingLine, ReverseArgs, account_for_role,
    load_entity_accounts, post_journal_entry, reverse_journal_entry,
};
use weldsuite_books_domain::tables::BANK_DEPOSITS;
use weldsuite_catalogs::entity_events::{
    BANK_DEPOSIT_CREATED, BANK_DEPOSIT_DELETED, BANK_DEPOSIT_UPDATED,
};
use weldsuite_db::{OrmConn, orm, utc_now, utc_timestamp};
use weldsuite_events::iso_timestamp;
use weldsuite_kit::cursor::{atob_url, btoa_url};
use weldsuite_kit::generate_id;
use weldsuite_kit::validation::{Field, Issues, Number, Presence, Text};
use weldsuite_legal_entities::{EntityRecordGuard, EntityTable};
use weldsuite_permissions::{PermissionGate, PermissionQueries};
use weldsuite_schema::tenant::{
    accounts, bank_accounts, bank_deposits, bank_transactions, journal_entries, journal_lines,
    parties, payments,
};

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
        // A record of an entity the request may not touch answers 404
        // (per-entity access; books-api `guardEntityRecords`).
        .route_layer(
            EntityRecordGuard::table(EntityTable::new("bank_deposits"), "Bank deposit").layer(),
        )
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

/// `leftJoin(parties, eq(parties.id, payments.contactId))`.
fn payment_contact() -> RelationDef {
    payments::Entity::belongs_to(parties::Entity)
        .from(payments::Column::ContactId)
        .to(parties::Column::Id)
        .into()
}

/// A received payment with what its entry left in Undeposited Funds and its
/// contact's name.
#[derive(Debug, FromQueryResult)]
struct UndepositedRow {
    #[sea_orm(nested)]
    payment: payments::Model,
    undeposited_amount: Option<BigDecimal>,
    party_display_name: Option<String>,
}

/// `listUndepositedPayments(db, entityId)`: the received payments not
/// deposited yet, with `sum(coalesce(debit, 0) - coalesce(credit, 0))` of
/// their entry's live lines on Undeposited Funds (read as a number, as the
/// worker reads the sum's text).
async fn list_undeposited(db: &PgPool, entity_id: &str) -> Result<Vec<Undeposited>, DbErr> {
    let accounts = load_entity_accounts(db, entity_id).await?;
    let Some(undeposited) = account_for_role(&accounts, "undeposited_funds", &[]) else {
        return Ok(Vec::new());
    };
    let net = sea_orm::ExprTrait::sub(
        Expr::expr(Func::coalesce([
            journal_lines::Column::Debit.into_expr(),
            Expr::val(0),
        ])),
        Func::coalesce([journal_lines::Column::Credit.into_expr(), Expr::val(0)]),
    );
    let rows = payments::Entity::find()
        .column_as(Expr::expr(Func::sum(net)), "undeposited_amount")
        .column_as(parties::Column::DisplayName, "party_display_name")
        .join(
            JoinType::InnerJoin,
            payments::Entity::belongs_to(journal_lines::Entity)
                .from(payments::Column::JournalEntryId)
                .to(journal_lines::Column::JournalEntryId)
                .into(),
        )
        .join(JoinType::LeftJoin, payment_contact())
        .filter(journal_lines::Column::AccountId.eq(text(undeposited, "id").map(str::to_owned)))
        .filter(journal_lines::Column::DeletedAt.is_null())
        .filter(payments::Column::EntityId.eq(entity_id))
        .filter(payments::Column::Type.eq("received"))
        .filter(payments::Column::DeletedAt.is_null())
        .filter(payments::Column::DepositId.is_null())
        .group_by(payments::Column::Id)
        .group_by(parties::Column::DisplayName)
        .order_by_asc(payments::Column::Date)
        .order_by_asc(payments::Column::CreatedAt)
        .into_model::<UndepositedRow>()
        .all(&orm(db))
        .await?;
    Ok(rows
        .into_iter()
        .filter_map(|row| {
            let amount = js_number_value(
                row.undeposited_amount
                    .map(|sum| Value::String(sum.to_plain_string()))
                    .as_ref(),
            );
            (amount > 0.0).then(|| Undeposited {
                payment: serde_json::to_value(row.payment).unwrap_or_default(),
                amount: round_money(amount),
                contact_name: row.party_display_name,
            })
        })
        .collect())
}

async fn undeposited(caller: Caller) -> Response {
    let result = async {
        let Some(entity_id) = resolve_entity_id(&caller).await? else {
            return Ok(all_rows(Vec::new()));
        };
        let rows = list_undeposited(&caller.db, &entity_id)
            .await?;
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

/// `$n::<type_name>`: text Postgres reads as the type, as the old statements
/// bound it.
fn cast(text: &str, type_name: &'static str) -> Expr {
    Func::cast_as(Expr::val(text), type_name).into()
}

/// The list's conditions (`and(...)` of the given filters), without the
/// cursor: what the page and its `count(*)` share.
fn deposits_of(
    entity_id: &str,
    (account, status, from, to): (Option<&str>, Option<&str>, Option<&str>, Option<&str>),
) -> sea_orm::Select<bank_deposits::Entity> {
    use bank_deposits::Column;
    bank_deposits::Entity::find()
        .filter(Column::EntityId.eq(entity_id))
        .filter(Column::DeletedAt.is_null())
        .apply_if(account, |q, account| {
            q.filter(Column::BankAccountId.eq(account))
        })
        .apply_if(status, |q, status| q.filter(Column::Status.eq(status)))
        .apply_if(from, |q, from| {
            q.filter(sea_orm::ExprTrait::gte(
                Column::Date.into_expr(),
                cast(from, "date"),
            ))
        })
        .apply_if(to, |q, to| {
            q.filter(sea_orm::ExprTrait::lte(
                Column::Date.into_expr(),
                cast(to, "date"),
            ))
        })
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
        let db = orm(&caller.db);
        // `date < cursor date or (date = cursor date and id < cursor id)`
        let before_cursor = after_date.as_deref().map(|day| {
            use bank_deposits::Column;
            Condition::any()
                .add(sea_orm::ExprTrait::lt(
                    Column::Date.into_expr(),
                    cast(day, "date"),
                ))
                .add(
                    Condition::all()
                        .add(sea_orm::ExprTrait::eq(
                            Column::Date.into_expr(),
                            cast(day, "date"),
                        ))
                        .add(Column::Id.lt(after_id.clone())),
                )
        });
        let rows = deposits_of(&entity_id, filters)
            .apply_if(before_cursor, QueryFilter::filter)
            .order_by_desc(bank_deposits::Column::Date)
            .order_by_desc(bank_deposits::Column::Id)
            .limit(u64::try_from(limit + 1).unwrap_or(0))
            .all(&db)
            .await?;
        let total = deposits_of(&entity_id, filters)
            .count(&db)
            .await?;
        let total = i64::try_from(total).unwrap_or(i64::MAX);
        let mut rows: Vec<Value> = rows
            .into_iter()
            .map(|row| serde_json::to_value(row).unwrap_or_default())
            .collect();
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

/// The live deposit `id` of the entity, as Drizzle returns it.
async fn find_deposit(db: &PgPool, entity_id: &str, id: &str) -> Result<Option<Value>, DbErr> {
    let row = bank_deposits::Entity::find()
        .filter(bank_deposits::Column::Id.eq(id))
        .filter(bank_deposits::Column::EntityId.eq(entity_id))
        .filter(bank_deposits::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await?;
    Ok(row.map(|row| serde_json::to_value(row).unwrap_or_default()))
}

/// A deposited payment and its contact's name.
#[derive(Debug, FromQueryResult)]
struct DepositedPayment {
    #[sea_orm(nested)]
    payment: payments::Model,
    party_display_name: Option<String>,
}

/// The deposit's live payments by date, each with its contact's name.
async fn deposited_payments(db: &impl ConnectionTrait, id: &str) -> Result<Vec<Value>, DbErr> {
    let payments = payments::Entity::find()
        .column_as(parties::Column::DisplayName, "party_display_name")
        .join(JoinType::LeftJoin, payment_contact())
        .filter(payments::Column::DepositId.eq(id))
        .filter(payments::Column::DeletedAt.is_null())
        .order_by_asc(payments::Column::Date)
        .into_model::<DepositedPayment>()
        .all(db)
        .await?;
    Ok(payments
        .into_iter()
        .map(
            |DepositedPayment {
                 payment,
                 party_display_name: name,
             }| {
                let row = serde_json::to_value(payment).unwrap_or_default();
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
            },
        )
        .collect())
}

/// `loadDepositDetail(db, deposit)`: the deposit with its payments, other
/// lines (account code and name) and bank account and entry.
async fn deposit_detail(db: &PgPool, deposit: &Value) -> Result<Value, DbErr> {
    let db = orm(db);
    let payments = deposited_payments(&db, text(deposit, "id").unwrap_or_default()).await?;
    let bank_name: Option<Option<String>> = match text(deposit, "bankAccountId") {
        Some(bank) => {
            bank_accounts::Entity::find_by_id(bank.to_owned())
                .select_only()
                .column(bank_accounts::Column::Name)
                .into_tuple()
                .one(&db)
                .await?
        }
        None => None,
    };
    let entry_number: Option<Option<String>> =
        match text(deposit, "journalEntryId").filter(|e| !e.is_empty()) {
            Some(entry) => {
                journal_entries::Entity::find_by_id(entry.to_owned())
                    .select_only()
                    .column(journal_entries::Column::EntryNumber)
                    .into_tuple()
                    .one(&db)
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
        accounts::Entity::find()
            .select_only()
            .columns([
                accounts::Column::Id,
                accounts::Column::Code,
                accounts::Column::Name,
            ])
            .filter(accounts::Column::Id.is_in(ids))
            .into_tuple()
            .all(&db)
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
        let Some(deposit) = find_deposit(&caller.db, &entity_id, &id)
            .await?
        else {
            return Err(Refusal::not_found("Bank deposit", &id));
        };
        Ok(ok(deposit_detail(&caller.db, &deposit)
            .await?))
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
    let bank = bank_accounts::Entity::find()
        .filter(bank_accounts::Column::Id.eq(data.bank_account_id.as_str()))
        .filter(bank_accounts::Column::EntityId.eq(entity_id))
        .filter(bank_accounts::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await?;
    let Some(bank) = bank.map(|row| serde_json::to_value(row).unwrap_or_default()) else {
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

    // One instant: the deposit's timestamps and the payments' `updatedAt`.
    let at = OffsetDateTime::now_utc();
    let stamp = iso_timestamp(at);
    let stamp_at = utc_timestamp(at);
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
                payments::Entity::update_many()
                    .col_expr(payments::Column::DepositId, Expr::value(deposit_key))
                    .col_expr(payments::Column::UpdatedAt, Expr::value(stamp_at))
                    .filter(payments::Column::Id.is_in(ids))
                    .filter(payments::Column::DepositId.is_null())
                    .exec(&OrmConn::new(conn))
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
        let Some(deposit) = find_deposit(&caller.db, &entity_id, &id)
            .await?
        else {
            return Err(Refusal::not_found("Bank deposit", &id));
        };
        let memo = memo
            .as_deref()
            .map(weldsuite_books_domain::jurisdictions::js_trim)
            .filter(|m| !m.is_empty())
            .map(str::to_owned);
        bank_deposits::Entity::update_many()
            .col_expr(bank_deposits::Column::Memo, Expr::value(memo.clone()))
            .col_expr(bank_deposits::Column::UpdatedAt, Expr::value(utc_now()))
            .filter(bank_deposits::Column::Id.eq(id.as_str()))
            .exec(&orm(&caller.db))
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
async fn release(db: &impl ConnectionTrait, id: &str, at: PrimitiveDateTime) -> Result<(), DbErr> {
    let none = || Expr::value(Option::<String>::None);
    bank_deposits::Entity::update_many()
        .col_expr(bank_deposits::Column::Status, Expr::value("void"))
        .col_expr(bank_deposits::Column::UpdatedAt, Expr::value(at))
        .filter(bank_deposits::Column::Id.eq(id))
        .exec(db)
        .await?;
    payments::Entity::update_many()
        .col_expr(payments::Column::DepositId, none())
        .col_expr(payments::Column::UpdatedAt, Expr::value(at))
        .filter(payments::Column::DepositId.eq(id))
        .exec(db)
        .await?;
    bank_transactions::Entity::update_many()
        .col_expr(
            bank_transactions::Column::Status,
            Expr::value("unreconciled"),
        )
        .col_expr(bank_transactions::Column::ReconciliationType, none())
        .col_expr(bank_transactions::Column::DepositId, none())
        .col_expr(bank_transactions::Column::JournalEntryId, none())
        .col_expr(bank_transactions::Column::UpdatedAt, Expr::value(at))
        .filter(bank_transactions::Column::DepositId.eq(id))
        .exec(db)
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
    let Some(deposit) = find_deposit(db, entity_id, id).await? else {
        return Err(posting("Deposit not found"));
    };
    if text(&deposit, "status") == Some("void") {
        return Err(posting("This deposit has already been voided"));
    }
    // One instant: the reversal's date and the released rows' `updatedAt`.
    let instant = OffsetDateTime::now_utc();
    let stamp = iso_timestamp(instant);
    let at = utc_timestamp(instant);
    match text(&deposit, "journalEntryId").filter(|e| !e.is_empty()) {
        Some(entry) => {
            let memo = text(&deposit, "memo")
                .filter(|m| !m.is_empty())
                .map(|m| format!(" — {m}"))
                .unwrap_or_default();
            let deposit_id = id.to_owned();
            let write: AlsoWrite = Box::new(move |conn, _| {
                Box::pin(async move {
                    release(&OrmConn::new(conn), &deposit_id, at)
                        .await
                })
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
            release(&OrmConn::new(&mut tx), id, at)
                .await?;
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
