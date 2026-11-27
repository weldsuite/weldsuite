//! `/api/payment-batches` (Rust only, edition feature `books-sepa-batches`):
//! paying approved supplier bills with a SEPA credit-transfer file.
//!
//! A batch is a `payment_runs` row with `method = 'sepa'` (no new table): the
//! bills and what the file says about each of them (supplier, IBAN, amount,
//! remittance) are its `items`, the suppliers held back its `holds`, the
//! execution date its `payment_date`, and `file_name` and `file_generated_at`
//! the file made. The file itself is written again from the items on every
//! download, so the bytes never change after the batch is made.
//!
//! The batch's status is its own: `exported` (the file is made and the bank
//! has not paid yet), `cancelled`. The existing `/api/payment-runs` routes
//! only touch `draft`, `pending_approval` and `approved` runs, so they leave a
//! batch alone, and they leave batches out of their list unless asked for
//! `method=sepa`.
//!
//! **Payment pending.** The bills keep their status (`approved`, `partial`,
//! `overdue`): the bank matcher, the aging report and every bill filter see
//! them as they did. A bill is *payment pending* while it is in an
//! `exported` batch and still has a balance (`GET /pending-bills`). When the
//! bank lines come in, the matcher links each to its bill as usual
//! ([`weldsuite_books_domain::bank_matching`]): the file asks the bank to book
//! every transfer on its own (`BtchBookg` false) and carries the bill number
//! as the end-to-end id, so each line matches one bill by amount, IBAN, name
//! and number. A batch reads as `completed` once every bill is settled.
//!
//! **Holds.** A supplier is left out of the batch (and told so) when its bank
//! details changed in the last ten days and nobody verified them (the same
//! rule as ACH payment runs, `bankDetailsChangedAt` / `bankDetailsVerifiedAt`),
//! or when the IBAN differs from the one the last batch paid that supplier
//! and nobody verified the vendor since. A bill in another open batch or run
//! is refused, not held.

use std::collections::HashMap;

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use http::{HeaderMap, HeaderValue, StatusCode, header};
use sea_orm::ActiveValue::Set;
use sea_orm::sea_query::Expr;
use sea_orm::{
    ColumnTrait, Condition, EntityTrait, PaginatorTrait, QueryFilter, QueryOrder, QuerySelect,
};
use serde_json::{Map, Value, json};
use weldsuite_books_domain::entity_context::{resolve_entity_base_currency, resolve_entity_id};
use weldsuite_books_domain::guards::{AuditInput, write_accounting_audit};
use weldsuite_books_domain::http::{BooksState, Caller, paged, validate};
use weldsuite_books_domain::identifiers::{is_valid_iban, normalize_iban};
use weldsuite_books_domain::js::{iso_from_millis, millis_of, parse_float, round_money, to_fixed};
use weldsuite_books_domain::sepa::{CreditTransferFile, Debtor, Transfer, credit_transfer_xml};
use weldsuite_catalogs::entity_events::{PAYMENT_BATCH_CANCELLED, PAYMENT_BATCH_CREATED};
use weldsuite_db::{PgPool, orm, utc_now};
use weldsuite_kit::generate_id;
use weldsuite_kit::validation::{Presence, Text};
use weldsuite_schema::tenant::{bills, payment_runs};

use super::holds::{RunHold, decode_holds, encode_holds, load_parties, vendor_ach_status};
use super::runs::{PAYABLE_BILL_STATUSES, items_of, open_run_items, s, text};
use super::settings::DEFAULT_HOLD_WINDOW_DAYS;
use super::{Answer, RunError, answer, bad, load_bank_account, not_found, require_entity};
use crate::rows::{date_of, decimal_of, int4, js, js_rows};

/// The method a batch has in `payment_runs.method`.
pub(crate) const METHOD: &str = "sepa";
/// The status of a batch whose file is made.
pub(crate) const EXPORTED: &str = "exported";
const CANCELLED: &str = "cancelled";
/// Bills in one file: banks take thousands, a person checks dozens.
const MAX_BILLS: usize = 500;

/// A hold code for a changed IBAN (the ACH codes are in `holds.rs`).
const IBAN_CHANGED: &str = "iban_changed";

fn money(value: f64) -> String {
    to_fixed(value, 2)
}

fn today() -> String {
    iso_from_millis(weldsuite_books_domain::http::now_ms())
        .unwrap_or_default()
        .chars()
        .take(10)
        .collect()
}

/// What an item of a batch says (the keys the file is written from).
struct BatchItem {
    bill_id: String,
    party_id: String,
    amount: String,
    name: String,
    iban: String,
    bic: Option<String>,
    end_to_end_id: String,
    remittance: String,
}

fn batch_items(run: &Value) -> Vec<BatchItem> {
    let text_of = |item: &Value, key: &str| s(item, key).to_owned();
    run.get("items")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|item| BatchItem {
                    bill_id: text_of(item, "billId"),
                    party_id: text_of(item, "partyId"),
                    amount: item
                        .get("amount")
                        .and_then(Value::as_f64)
                        .map_or_else(String::new, money),
                    name: text_of(item, "name"),
                    iban: text_of(item, "iban"),
                    bic: text(item, "bic").map(str::to_owned),
                    end_to_end_id: text_of(item, "endToEndId"),
                    remittance: text_of(item, "remittance"),
                })
                .collect()
        })
        .unwrap_or_default()
}

// ── POST / ──────────────────────────────────────────────────────────────────

struct CreateBatch {
    bank_account_id: String,
    bill_ids: Vec<String>,
    execution_date: String,
}

fn read_create(
    issues: &mut weldsuite_kit::validation::Issues,
    body: &Map<String, Value>,
) -> CreateBatch {
    let bank_account_id = issues
        .text(body, "bankAccountId", Presence::Required, Some(1), Some(30))
        .into_option()
        .unwrap_or_default();
    let execution_date = issues
        .text(
            body,
            "executionDate",
            Presence::Required,
            Some(10),
            Some(10),
        )
        .into_option()
        .unwrap_or_default();
    let bill_ids = issues
        .list(
            body,
            "billIds",
            Presence::Required,
            Some(1),
            Some(MAX_BILLS),
            |issues, item| issues.item_text(item, Text::length(Some(1), Some(30))),
        )
        .into_option()
        .unwrap_or_default();
    CreateBatch {
        bank_account_id,
        bill_ids,
        execution_date,
    }
}

pub(crate) async fn create(
    caller: Caller,
    State(state): State<BooksState>,
    headers: HeaderMap,
    raw: Bytes,
) -> Response {
    let body = match validate(&headers, &raw, read_create) {
        Ok(body) => body,
        Err(refusal) => return refusal.respond("Failed to create the payment batch"),
    };
    let result: Answer = async {
        let entity_id = require_entity(&caller).await?;
        let (batch, held) = create_batch(&caller, &entity_id, &body).await?;
        let mut view = detail_view(&caller.db, &batch).await?;
        view["held"] = held_view(&caller.db, &decode_holds(batch.get("holds"))).await?;
        write_accounting_audit(
            &caller,
            &caller.db,
            AuditInput {
                accounting_entity_id: Some(&entity_id),
                entity_type: "payment_batch",
                entity_id: s(&batch, "id"),
                action: "created",
                changes: None,
            },
        )
        .await;
        caller.publish(
            &state,
            PAYMENT_BATCH_CREATED,
            s(&batch, "id"),
            event_data(&batch, held),
        );
        Ok(weldsuite_books_domain::http::created(view))
    }
    .await;
    answer(result, "create the payment batch")
}

fn event_data(batch: &Value, held: usize) -> Value {
    json!({
        "id": batch["id"],
        "status": batch["status"],
        "bankAccountId": batch["bankAccountId"],
        "executionDate": batch["paymentDate"],
        "totalAmount": batch["totalAmount"],
        "paymentCount": batch["paymentCount"],
        "held": held,
    })
}

/// The IBAN the last batch (not cancelled) paid `party_id`, per party.
async fn last_ibans(
    db: &PgPool,
    entity_id: &str,
    party_ids: &[String],
) -> Result<HashMap<String, (String, String)>, RunError> {
    let rows = payment_runs::Entity::find()
        .filter(payment_runs::Column::EntityId.eq(entity_id))
        .filter(payment_runs::Column::Method.eq(METHOD))
        .filter(payment_runs::Column::DeletedAt.is_null())
        .filter(payment_runs::Column::Status.ne(CANCELLED))
        .order_by_desc(payment_runs::Column::CreatedAt)
        .limit(50)
        .all(&orm(db))
        .await?;
    let mut found: HashMap<String, (String, String)> = HashMap::new();
    for run in js_rows!(rows)? {
        let made = text(&run, "createdAt").unwrap_or_default().to_owned();
        for item in batch_items(&run) {
            if party_ids.contains(&item.party_id) && !found.contains_key(&item.party_id) {
                found.insert(item.party_id, (normalize_iban(&item.iban), made.clone()));
            }
        }
    }
    Ok(found)
}

/// Why `party` is held back from a batch, if it is.
fn hold_of(
    party: &Value,
    name: &str,
    iban: &str,
    last: Option<&(String, String)>,
    now: i64,
) -> Option<(&'static str, String)> {
    if vendor_ach_status(party, DEFAULT_HOLD_WINDOW_DAYS, now).hold_active {
        let day: String = text(party, "bankDetailsChangedAt")
            .unwrap_or_default()
            .chars()
            .take(10)
            .collect();
        return Some((
            "bank_details_changed",
            format!(
                "{name}'s bank details changed on {day} and have not been verified. Call the supplier on a number you already had, then verify the change on the supplier."
            ),
        ));
    }
    if let Some((previous, made)) = last
        && *previous != normalize_iban(iban)
    {
        let verified = text(party, "bankDetailsVerifiedAt")
            .and_then(millis_of)
            .zip(millis_of(made))
            .is_some_and(|(verified, made)| verified >= made);
        if !verified {
            return Some((
                IBAN_CHANGED,
                format!(
                    "{name}'s IBAN is not the one the last batch paid ({previous}). Call the supplier on a number you already had, then verify the change on the supplier."
                ),
            ));
        }
    }
    None
}

#[allow(clippy::too_many_lines)] // the checks of one batch, in the order a person meets them
async fn create_batch(
    caller: &Caller,
    entity_id: &str,
    body: &CreateBatch,
) -> Result<(Value, usize), RunError> {
    let db = &caller.db;
    if !weldsuite_books_domain::dates::is_iso_date(&body.execution_date) {
        return Err(bad(
            "INVALID_DATE",
            "Use a real execution date (YYYY-MM-DD).",
            None,
        ));
    }
    if body.execution_date.as_str() < today().as_str() {
        return Err(bad(
            "EXECUTION_DATE_PAST",
            "The execution date can't be in the past.",
            None,
        ));
    }
    let bank = load_bank_account(db, entity_id, &body.bank_account_id).await?;
    if bank.get("isActive") == Some(&Value::Bool(false)) {
        return Err(bad(
            "BANK_ACCOUNT_INACTIVE",
            "This bank account is inactive.",
            None,
        ));
    }
    let own_iban = text(&bank, "iban").unwrap_or_default();
    if !is_valid_iban(own_iban) {
        return Err(bad(
            "BANK_ACCOUNT_IBAN",
            "The bank account has no valid IBAN. Add it before paying with a SEPA file.",
            None,
        ));
    }
    let base = resolve_entity_base_currency(db, entity_id).await?;
    if text(&bank, "currency").is_some_and(|c| c != "EUR") || base != "EUR" {
        return Err(bad(
            "NOT_EUR",
            "A SEPA file pays EUR bills from a EUR bank account.",
            None,
        ));
    }
    let mut unique = body.bill_ids.clone();
    unique.sort();
    unique.dedup();
    if unique.len() != body.bill_ids.len() {
        return Err(bad(
            "DUPLICATE_BILL",
            "A bill can only be in a batch once.",
            None,
        ));
    }
    let rows = bills::Entity::find()
        .filter(bills::Column::Id.is_in(&body.bill_ids))
        .filter(bills::Column::DeletedAt.is_null())
        .all(&orm(db))
        .await?;
    let found = js_rows!(rows)?;
    // Bills in an open batch or run are somebody's payment already.
    let mut taken: HashMap<String, String> = HashMap::new();
    for (run_id, items) in open_run_items(db, entity_id).await? {
        for item in items_of(items.as_ref()) {
            taken.insert(item.bill_id, run_id.clone());
        }
    }
    for (run_id, bill_id) in pending_batch_bills(db, entity_id).await? {
        taken.insert(bill_id, run_id);
    }
    let parties = load_parties(
        db,
        &found
            .iter()
            .map(|b| s(b, "contactId").to_owned())
            .collect::<Vec<_>>(),
    )
    .await?;
    let mut candidates: Vec<(Value, Value, f64)> = Vec::new();
    for bill_id in &body.bill_ids {
        let Some(bill) = found.iter().find(|b| s(b, "id") == bill_id) else {
            return Err(bad(
                "BILL_NOT_FOUND",
                &format!("Bill {bill_id} not found."),
                Some(json!({ "billId": bill_id })),
            ));
        };
        let label = text(bill, "billNumber").unwrap_or(bill_id).to_owned();
        let details = Some(json!({ "billId": bill_id }));
        if s(bill, "entityId") != entity_id {
            return Err(bad(
                "BILL_OTHER_ENTITY",
                &format!("Bill {label} belongs to a different accounting entity."),
                details,
            ));
        }
        let status = s(bill, "status");
        if !PAYABLE_BILL_STATUSES.contains(&status) || s(bill, "type") != "standard" {
            return Err(bad(
                "BILL_NOT_PAYABLE",
                &format!(
                    "Bill {label} is {status} and can't be paid in a batch. Only approved bills with a balance are paid."
                ),
                details,
            ));
        }
        let currency = text(bill, "currency").unwrap_or("EUR");
        if currency != "EUR" {
            return Err(bad(
                "BILL_CURRENCY",
                &format!("Bill {label} is in {currency}: a SEPA file pays EUR bills only."),
                details,
            ));
        }
        let open = round_money(parse_float(text(bill, "balanceDue").unwrap_or("0")));
        if open <= 0.0 {
            return Err(bad(
                "BILL_NOT_PAYABLE",
                &format!("Bill {label} has no open balance."),
                details,
            ));
        }
        if let Some(other) = taken.get(bill_id) {
            return Err(bad(
                "BILL_IN_OTHER_RUN",
                &format!("Bill {label} is already in another payment run or batch ({other})."),
                details,
            ));
        }
        let party = parties.iter().find(|p| s(p, "id") == s(bill, "contactId"));
        let Some(party) = party else {
            return Err(bad(
                "NO_SUPPLIER",
                &format!("Bill {label} has no supplier to pay."),
                details,
            ));
        };
        let iban = text(party, "iban").unwrap_or_default();
        if !is_valid_iban(iban) {
            let name = text(party, "displayName").unwrap_or("The supplier");
            return Err(bad(
                "NO_IBAN",
                &format!(
                    "{name} has no valid IBAN. Add it on the supplier before paying bill {label}."
                ),
                Some(json!({ "billId": bill_id, "partyId": s(party, "id") })),
            ));
        }
        candidates.push((bill.clone(), party.clone(), open));
    }
    // Holds: whole suppliers are left out.
    let party_ids: Vec<String> = candidates
        .iter()
        .map(|(_, party, _)| s(party, "id").to_owned())
        .collect();
    let last = last_ibans(db, entity_id, &party_ids).await?;
    let now = weldsuite_books_domain::http::now_ms();
    let mut holds: Vec<RunHold> = Vec::new();
    let mut held_parties: Vec<String> = Vec::new();
    for (_, party, _) in &candidates {
        let id = s(party, "id");
        if held_parties.iter().any(|h| h == id) {
            continue;
        }
        let name = text(party, "displayName").unwrap_or(id);
        if let Some((code, message)) = hold_of(
            party,
            name,
            text(party, "iban").unwrap_or_default(),
            last.get(id),
            now,
        ) {
            held_parties.push(id.to_owned());
            holds.push(RunHold {
                party_id: id.to_owned(),
                code: code.to_owned(),
                message,
                key: String::new(),
                released: Value::Null,
            });
        }
    }
    let paying: Vec<&(Value, Value, f64)> = candidates
        .iter()
        .filter(|(_, party, _)| !held_parties.iter().any(|h| h == s(party, "id")))
        .collect();
    if paying.is_empty() {
        let names: Vec<String> = holds.iter().map(|h| h.message.clone()).collect();
        return Err(bad(
            "ALL_HELD",
            &format!("Every supplier is on hold: {}", names.join(" ")),
            Some(json!({ "holds": names })),
        ));
    }
    let mut items = Vec::with_capacity(paying.len());
    let mut total_cents: f64 = 0.0;
    let mut payees: Vec<&str> = Vec::new();
    for (bill, party, open) in &paying {
        let number = text(bill, "billNumber").unwrap_or_default();
        let remittance = text(bill, "externalReference")
            .filter(|r| !r.is_empty())
            .or_else(|| text(bill, "reference").filter(|r| !r.is_empty()))
            .unwrap_or(number);
        items.push(json!({
            "billId": s(bill, "id"),
            "amount": weldsuite_books_domain::js::number_value(*open),
            "partyId": s(party, "id"),
            "name": text(party, "displayName").unwrap_or_default(),
            "iban": normalize_iban(text(party, "iban").unwrap_or_default()),
            "bic": text(party, "bic").filter(|b| !b.is_empty()),
            "endToEndId": if number.is_empty() { s(bill, "id") } else { number },
            "remittance": remittance,
        }));
        total_cents = round_money(total_cents + open);
        if !payees.contains(&s(party, "id")) {
            payees.push(s(party, "id"));
        }
    }
    let id = generate_id("prn");
    let at = utc_now();
    let file_name = format!("sepa-{}-{}.xml", body.execution_date, id);
    // The file must be makeable: an IBAN or an amount it refuses fails the
    // batch now, not at the download.
    let probe = RunItemsFile::of(&id, &body.execution_date, &bank, &items, &utc_stamp());
    probe.xml()?;
    let row = payment_runs::Entity::insert(payment_runs::ActiveModel {
        id: Set(id.clone()),
        entity_id: Set(entity_id.to_owned()),
        bank_account_id: Set(body.bank_account_id.clone()),
        method: Set(METHOD.to_owned()),
        status: Set(EXPORTED.to_owned()),
        payment_date: Set(date_of(&body.execution_date)?),
        sec_code: Set(None),
        same_day: Set(false),
        total_amount: Set(decimal_of(&money(total_cents))?),
        payment_count: Set(int4(i64::try_from(items.len()).unwrap_or(0))?),
        required_approvals: Set(0),
        approvals: Set(Some(json!([]))),
        items: Set(Some(Value::Array(items))),
        holds: Set(Some(encode_holds(&holds))),
        file_name: Set(Some(file_name)),
        file_generated_at: Set(Some(at)),
        created_by: Set(Some(caller.user_id.clone())),
        created_at: Set(at),
        updated_at: Set(at),
        ..Default::default()
    })
    .exec_with_returning(&orm(db))
    .await?;
    Ok((js!(row)?, holds.len()))
}

fn utc_stamp() -> String {
    iso_from_millis(weldsuite_books_domain::http::now_ms()).unwrap_or_default()
}

/// The batch as the file maker reads it.
struct RunItemsFile {
    message_id: String,
    created_at: String,
    execution_date: String,
    debtor_name: String,
    debtor_iban: String,
    debtor_bic: Option<String>,
    items: Vec<BatchItem>,
}

impl RunItemsFile {
    fn of(id: &str, date: &str, bank: &Value, items: &[Value], created_at: &str) -> Self {
        let run = json!({ "items": items });
        Self {
            message_id: id.to_owned(),
            created_at: created_at.to_owned(),
            execution_date: date.to_owned(),
            debtor_name: text(bank, "accountHolderName")
                .filter(|n| !n.is_empty())
                .or_else(|| text(bank, "name"))
                .unwrap_or_default()
                .to_owned(),
            debtor_iban: text(bank, "iban").unwrap_or_default().to_owned(),
            debtor_bic: text(bank, "bic").map(str::to_owned),
            items: batch_items(&run),
        }
    }

    fn xml(&self) -> Result<String, RunError> {
        let file = CreditTransferFile {
            message_id: self.message_id.clone(),
            created_at: self.created_at.clone(),
            execution_date: self.execution_date.clone(),
            debtor: Debtor {
                name: self.debtor_name.clone(),
                iban: self.debtor_iban.clone(),
                bic: self.debtor_bic.clone(),
            },
            transfers: self
                .items
                .iter()
                .map(|item| Transfer {
                    end_to_end_id: item.end_to_end_id.clone(),
                    amount: item.amount.clone(),
                    currency: "EUR".to_owned(),
                    creditor_name: item.name.clone(),
                    creditor_iban: item.iban.clone(),
                    creditor_bic: item.bic.clone(),
                    remittance: item.remittance.clone(),
                })
                .collect(),
        };
        credit_transfer_xml(&file).map_err(|error| bad("INVALID_FILE", &error.to_string(), None))
    }
}

/// `(batch id, bill id)` of the bills still waiting for their bank line.
async fn pending_batch_bills(
    db: &PgPool,
    entity_id: &str,
) -> Result<Vec<(String, String)>, RunError> {
    let rows: Vec<(String, Option<Value>)> = payment_runs::Entity::find()
        .select_only()
        .columns([payment_runs::Column::Id, payment_runs::Column::Items])
        .filter(payment_runs::Column::EntityId.eq(entity_id))
        .filter(payment_runs::Column::Method.eq(METHOD))
        .filter(payment_runs::Column::Status.eq(EXPORTED))
        .filter(payment_runs::Column::DeletedAt.is_null())
        .into_tuple()
        .all(&orm(db))
        .await?;
    let mut pairs = Vec::new();
    for (run_id, items) in rows {
        for item in items_of(items.as_ref()) {
            pairs.push((run_id.clone(), item.bill_id));
        }
    }
    if pairs.is_empty() {
        return Ok(pairs);
    }
    // Only bills that still have something to pay.
    let ids: Vec<&str> = pairs.iter().map(|(_, bill)| bill.as_str()).collect();
    let open: Vec<String> = bills::Entity::find()
        .select_only()
        .column(bills::Column::Id)
        .filter(bills::Column::Id.is_in(ids))
        .filter(bills::Column::DeletedAt.is_null())
        .filter(bills::Column::Status.is_in(PAYABLE_BILL_STATUSES))
        .filter(bills::Column::BalanceDue.gt(0))
        .into_tuple()
        .all(&orm(db))
        .await?;
    pairs.retain(|(_, bill)| open.contains(bill));
    Ok(pairs)
}

// ── Views ───────────────────────────────────────────────────────────────────

/// The bills of `runs` by id, with what a list needs of each.
async fn bills_of(db: &PgPool, runs: &[Value]) -> Result<HashMap<String, Value>, RunError> {
    let ids: Vec<String> = runs
        .iter()
        .flat_map(|run| items_of(run.get("items")))
        .map(|item| item.bill_id)
        .collect();
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows = bills::Entity::find()
        .filter(bills::Column::Id.is_in(&ids))
        .all(&orm(db))
        .await?;
    Ok(js_rows!(rows)?
        .into_iter()
        .map(|bill| (s(&bill, "id").to_owned(), bill))
        .collect())
}

/// A bill is settled when it is paid, or gone, or has no balance.
fn settled(bill: Option<&Value>) -> bool {
    match bill {
        None => true,
        Some(bill) => {
            bill.get("deletedAt").is_some_and(|d| !d.is_null())
                || s(bill, "status") == "paid"
                || parse_float(text(bill, "balanceDue").unwrap_or("0")) <= 0.0
        }
    }
}

fn summary(run: &Value, bills: &HashMap<String, Value>, bank_name: Value) -> Map<String, Value> {
    let items = items_of(run.get("items"));
    let paid = items
        .iter()
        .filter(|item| settled(bills.get(&item.bill_id)))
        .count();
    let stored = s(run, "status");
    let status = if stored == EXPORTED && paid == items.len() && !items.is_empty() {
        "completed"
    } else {
        stored
    };
    let mut out = Map::new();
    out.insert("id".to_owned(), run["id"].clone());
    out.insert("status".to_owned(), json!(status));
    out.insert("bankAccountId".to_owned(), run["bankAccountId"].clone());
    out.insert("bankAccountName".to_owned(), bank_name);
    out.insert("executionDate".to_owned(), run["paymentDate"].clone());
    out.insert("totalAmount".to_owned(), run["totalAmount"].clone());
    out.insert("paymentCount".to_owned(), run["paymentCount"].clone());
    out.insert("billCount".to_owned(), json!(items.len()));
    out.insert("paidBillCount".to_owned(), json!(paid));
    out.insert(
        "heldCount".to_owned(),
        json!(decode_holds(run.get("holds")).len()),
    );
    out.insert("fileName".to_owned(), run["fileName"].clone());
    out.insert("fileGeneratedAt".to_owned(), run["fileGeneratedAt"].clone());
    out.insert("createdBy".to_owned(), run["createdBy"].clone());
    out.insert("createdAt".to_owned(), run["createdAt"].clone());
    out
}

async fn bank_name(db: &PgPool, id: &str) -> Result<Value, RunError> {
    let name: Option<String> = weldsuite_schema::tenant::bank_accounts::Entity::find()
        .select_only()
        .column(weldsuite_schema::tenant::bank_accounts::Column::Name)
        .filter(weldsuite_schema::tenant::bank_accounts::Column::Id.eq(id))
        .into_tuple()
        .one(&orm(db))
        .await?;
    Ok(json!(name))
}

/// The batch with its bills.
async fn detail_view(db: &PgPool, run: &Value) -> Result<Value, RunError> {
    let bills = bills_of(db, std::slice::from_ref(run)).await?;
    let mut view = summary(run, &bills, bank_name(db, s(run, "bankAccountId")).await?);
    let rows: Vec<Value> = batch_items(run)
        .into_iter()
        .map(|item| {
            let bill = bills.get(&item.bill_id);
            let field = |key: &str| bill.and_then(|b| b.get(key)).cloned().unwrap_or(Value::Null);
            json!({
                "billId": item.bill_id,
                "billNumber": field("billNumber"),
                "externalReference": field("externalReference"),
                "partyId": item.party_id,
                "contactName": if item.name.is_empty() { field("contactName") } else { json!(item.name) },
                "iban": item.iban,
                "amount": item.amount,
                "remittance": item.remittance,
                "billStatus": field("status"),
                "balanceDue": field("balanceDue"),
                "paid": settled(bill),
            })
        })
        .collect();
    view.insert("bills".to_owned(), Value::Array(rows));
    Ok(Value::Object(view))
}

/// The holds of a batch with their supplier's name.
async fn held_view(db: &PgPool, holds: &[RunHold]) -> Result<Value, RunError> {
    let ids: Vec<String> = holds.iter().map(|h| h.party_id.clone()).collect();
    let parties = load_parties(db, &ids).await?;
    Ok(Value::Array(
        holds
            .iter()
            .map(|hold| {
                let name = parties
                    .iter()
                    .find(|p| s(p, "id") == hold.party_id)
                    .and_then(|p| text(p, "displayName"));
                json!({
                    "partyId": hold.party_id,
                    "contactName": name,
                    "code": hold.code,
                    "message": hold.message,
                })
            })
            .collect(),
    ))
}

// ── GET /, GET /:id, GET /pending-bills ─────────────────────────────────────

pub(crate) async fn list(caller: Caller) -> Response {
    let result: Answer = async {
        let q = caller.query();
        let Some(entity_id) = resolve_entity_id(&caller).await? else {
            return Ok(paged(Vec::new(), 0, false, None));
        };
        let page_size: u64 = q
            .present("pageSize")
            .and_then(|v| v.parse().ok())
            .map_or(25, |n: u64| n.clamp(1, 100));
        let page: u64 = q
            .present("page")
            .and_then(|v| v.parse().ok())
            .map_or(1, |n: u64| n.max(1));
        let mut condition = Condition::all()
            .add(payment_runs::Column::EntityId.eq(entity_id.as_str()))
            .add(payment_runs::Column::Method.eq(METHOD))
            .add(payment_runs::Column::DeletedAt.is_null());
        if let Some(status) = q.present("status").filter(|s| *s != "completed") {
            condition = condition.add(payment_runs::Column::Status.eq(status));
        }
        let db = orm(&caller.db);
        let total = payment_runs::Entity::find()
            .filter(condition.clone())
            .count(&db)
            .await?;
        let rows = payment_runs::Entity::find()
            .filter(condition)
            .order_by_desc(payment_runs::Column::CreatedAt)
            .order_by_desc(payment_runs::Column::Id)
            .limit(page_size)
            .offset((page - 1) * page_size)
            .all(&db)
            .await?;
        let runs = js_rows!(rows)?;
        let bills = bills_of(&caller.db, &runs).await?;
        let mut views = Vec::with_capacity(runs.len());
        for run in &runs {
            let name = bank_name(&caller.db, s(run, "bankAccountId")).await?;
            views.push(Value::Object(summary(run, &bills, name)));
        }
        let shown = (page - 1) * page_size + u64::try_from(views.len()).unwrap_or(0);
        Ok(paged(
            views,
            i64::try_from(total).unwrap_or(i64::MAX),
            shown < total,
            None,
        ))
    }
    .await;
    answer(result, "fetch payment batches")
}

async fn load_batch(db: &PgPool, entity_id: &str, id: &str) -> Result<Value, RunError> {
    let row = payment_runs::Entity::find()
        .filter(payment_runs::Column::Id.eq(id))
        .filter(payment_runs::Column::EntityId.eq(entity_id))
        .filter(payment_runs::Column::Method.eq(METHOD))
        .filter(payment_runs::Column::DeletedAt.is_null())
        .one(&orm(db))
        .await?;
    match row {
        Some(row) => Ok(js!(row)?),
        None => Err(not_found("Payment batch", id)),
    }
}

pub(crate) async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    let result: Answer = async {
        let entity_id = require_entity(&caller).await?;
        let batch = load_batch(&caller.db, &entity_id, &id).await?;
        let mut view = detail_view(&caller.db, &batch).await?;
        view["held"] = held_view(&caller.db, &decode_holds(batch.get("holds"))).await?;
        Ok(weldsuite_books_domain::http::ok(view))
    }
    .await;
    answer(result, "fetch the payment batch")
}

pub(crate) async fn pending_bills(caller: Caller) -> Response {
    let result: Answer = async {
        let Some(entity_id) = resolve_entity_id(&caller).await? else {
            return Ok(weldsuite_books_domain::http::all_rows(Vec::new()));
        };
        let pairs = pending_batch_bills(&caller.db, &entity_id).await?;
        let mut dates: HashMap<String, Value> = HashMap::new();
        for (run_id, _) in &pairs {
            if !dates.contains_key(run_id) {
                let run = load_batch(&caller.db, &entity_id, run_id).await?;
                dates.insert(run_id.clone(), run["paymentDate"].clone());
            }
        }
        let rows = pairs
            .into_iter()
            .map(|(run_id, bill_id)| {
                json!({
                    "billId": bill_id,
                    "batchId": run_id,
                    "executionDate": dates.get(&run_id).cloned().unwrap_or(Value::Null),
                })
            })
            .collect();
        Ok(weldsuite_books_domain::http::all_rows(rows))
    }
    .await;
    answer(result, "fetch the bills with a payment pending")
}

// ── GET /:id/file ───────────────────────────────────────────────────────────

pub(crate) async fn file(caller: Caller, Path(id): Path<String>) -> Response {
    let result: Answer = async {
        let entity_id = require_entity(&caller).await?;
        let batch = load_batch(&caller.db, &entity_id, &id).await?;
        if s(&batch, "status") == CANCELLED {
            return Err(bad(
                "BATCH_CANCELLED",
                "This batch is cancelled; its file is not to be sent to the bank.",
                None,
            ));
        }
        let bank = load_bank_account(&caller.db, &entity_id, s(&batch, "bankAccountId")).await?;
        let items: Vec<Value> = batch
            .get("items")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let created = text(&batch, "fileGeneratedAt")
            .or_else(|| text(&batch, "createdAt"))
            .unwrap_or_default();
        let xml = RunItemsFile::of(
            s(&batch, "id"),
            s(&batch, "paymentDate"),
            &bank,
            &items,
            created,
        )
        .xml()?;
        let name = text(&batch, "fileName").unwrap_or("sepa.xml");
        let mut response = (StatusCode::OK, xml).into_response();
        let headers = response.headers_mut();
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/xml; charset=utf-8"),
        );
        if let Ok(value) = HeaderValue::from_str(&format!("attachment; filename=\"{name}\"")) {
            headers.insert(header::CONTENT_DISPOSITION, value);
        }
        Ok(response)
    }
    .await;
    answer(result, "build the SEPA file")
}

// ── POST /:id/cancel ────────────────────────────────────────────────────────

pub(crate) async fn cancel(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
) -> Response {
    let result: Answer = async {
        let entity_id = require_entity(&caller).await?;
        let batch = load_batch(&caller.db, &entity_id, &id).await?;
        if s(&batch, "status") != EXPORTED {
            return Err(bad(
                "BATCH_NOT_CANCELLABLE",
                &format!("A {} batch can't be cancelled.", s(&batch, "status")),
                None,
            ));
        }
        let bills = bills_of(&caller.db, std::slice::from_ref(&batch)).await?;
        let all = summary(&batch, &bills, Value::Null);
        if all.get("status") == Some(&json!("completed")) {
            return Err(bad(
                "BATCH_NOT_CANCELLABLE",
                "Every bill of this batch is paid; there is nothing to release.",
                None,
            ));
        }
        // Only while it is still `exported`: two cancels are one.
        let rows = payment_runs::Entity::update_many()
            .col_expr(payment_runs::Column::Status, Expr::value(CANCELLED))
            .col_expr(payment_runs::Column::UpdatedAt, Expr::value(utc_now()))
            .filter(payment_runs::Column::Id.eq(id.as_str()))
            .filter(payment_runs::Column::Status.eq(EXPORTED))
            .exec_with_returning(&orm(&caller.db))
            .await?;
        let Some(row) = rows.into_iter().next() else {
            return Err(bad(
                "BATCH_NOT_CANCELLABLE",
                "The batch changed while it was being cancelled.",
                None,
            ));
        };
        let cancelled = js!(row)?;
        let mut changes = Map::new();
        changes.insert(
            "status".to_owned(),
            json!({ "old": EXPORTED, "new": CANCELLED }),
        );
        write_accounting_audit(
            &caller,
            &caller.db,
            AuditInput {
                accounting_entity_id: Some(&entity_id),
                entity_type: "payment_batch",
                entity_id: &id,
                action: "cancelled",
                changes: Some(changes),
            },
        )
        .await;
        caller.publish(
            &state,
            PAYMENT_BATCH_CANCELLED,
            &id,
            event_data(&cancelled, 0),
        );
        let mut view = detail_view(&caller.db, &cancelled).await?;
        view["held"] = held_view(&caller.db, &decode_holds(cancelled.get("holds"))).await?;
        Ok(weldsuite_books_domain::http::ok(view))
    }
    .await;
    answer(result, "cancel the payment batch")
}

#[cfg(test)]
#[allow(
    clippy::disallowed_methods,
    clippy::unwrap_used,
    clippy::too_many_lines,
    clippy::assert_is_empty,
    clippy::int_plus_one,
    clippy::cloned_ref_to_slice_refs,
    clippy::len_zero,
    clippy::ignored_unit_patterns,
    clippy::unused_async,
    reason = "test fixtures are written in SQL; each test is one scenario read top to bottom"
)]
mod tests {
    use super::super::runs::{OPEN_RUN_STATUSES, RunItem};
    use super::*;

    #[test]
    fn items_read_back_as_the_file_wants_them() {
        let run = json!({ "items": [{
            "billId": "bil_1", "amount": 12.5, "partyId": "pty_1", "name": "Acme",
            "iban": "NL02ABNA0123456789", "bic": null, "endToEndId": "B-1", "remittance": "INV 1"
        }] });
        let items = batch_items(&run);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].amount, "12.50");
        assert_eq!(items[0].bic, None);
        assert_eq!(items[0].remittance, "INV 1");
        // `RunItem` (the payment runs' reading of the same column) still reads it.
        let run_items: Vec<RunItem> = items_of(run.get("items"));
        assert_eq!(run_items[0].bill_id, "bil_1");
    }

    #[test]
    fn a_changed_iban_holds_until_verified() {
        let party = json!({ "id": "pty_1" });
        let last = (
            "NL02ABNA0123456789".to_owned(),
            "2026-11-01T10:00:00.000Z".to_owned(),
        );
        let now = millis_of("2026-11-27T10:00:00.000Z").unwrap();
        // The same IBAN (any spacing or case) is no change.
        assert!(hold_of(&party, "Acme", "nl02 abna 0123 4567 89", Some(&last), now).is_none());
        // Another one holds ...
        let hold = hold_of(&party, "Acme", "DE89370400440532013000", Some(&last), now);
        assert_eq!(hold.map(|h| h.0), Some(IBAN_CHANGED));
        // ... until the supplier was verified after that batch.
        let verified =
            json!({ "id": "pty_1", "bankDetailsVerifiedAt": "2026-11-20T10:00:00.000Z" });
        assert!(
            hold_of(
                &verified,
                "Acme",
                "DE89370400440532013000",
                Some(&last),
                now
            )
            .is_none()
        );
        // A first batch has nothing to compare with.
        assert!(hold_of(&party, "Acme", "DE89370400440532013000", None, now).is_none());
    }

    #[test]
    fn recently_changed_bank_details_hold() {
        let now = millis_of("2026-11-27T10:00:00.000Z").unwrap();
        let party = json!({ "id": "pty_1", "bankDetailsChangedAt": "2026-11-25T10:00:00.000Z" });
        let hold = hold_of(&party, "Acme", "NL02ABNA0123456789", None, now);
        assert_eq!(hold.map(|h| h.0), Some("bank_details_changed"));
        let old = json!({ "id": "pty_1", "bankDetailsChangedAt": "2026-10-01T10:00:00.000Z" });
        assert!(hold_of(&old, "Acme", "NL02ABNA0123456789", None, now).is_none());
    }

    #[test]
    fn open_statuses_do_not_include_a_batch() {
        assert!(!OPEN_RUN_STATUSES.contains(&EXPORTED));
    }

    // ── Against the tenant schema (`WELDSUITE_TEST_TENANT_URL`) ─────────────

    use axum::body::Bytes;
    use axum::extract::{Path, State};
    use sqlx::PgPool;

    use crate::test_support::{
        World, answer, answer_of, company, fresh, row_of, supplier, text as field,
    };

    async fn bill(
        db: &PgPool,
        entity: &str,
        contact: &str,
        number: &str,
        total: &str,
        status: &str,
        currency: &str,
    ) -> String {
        let id = fresh("bil");
        sqlx::query(
            "insert into bills (id, entity_id, bill_number, type, status, contact_id, contact_name, issue_date, \
               due_date, currency, total, balance_due, amount_paid, external_reference) \
             values ($1, $2, $3, 'standard', $4, $5, 'Supplier', now(), now() + interval '14 days', $6, \
               $7::numeric, $7::numeric, 0, $8)",
        )
        .bind(&id)
        .bind(entity)
        .bind(number)
        .bind(status)
        .bind(contact)
        .bind(currency)
        .bind(total)
        .bind(format!("INV-{number}"))
        .execute(db)
        .await
        .unwrap();
        id
    }

    fn tomorrow() -> String {
        iso_from_millis(weldsuite_books_domain::http::now_ms() + 86_400_000)
            .unwrap()
            .chars()
            .take(10)
            .collect()
    }

    async fn make(
        world: &World,
        entity: &str,
        body: serde_json::Value,
    ) -> (u16, serde_json::Value) {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json"),
        );
        let caller = world.caller(entity);
        answer_of(
            create(
                caller,
                State(world.state.clone()),
                headers,
                Bytes::from(serde_json::to_vec(&body).unwrap()),
            )
            .await,
        )
        .await
    }

    /// The elements of a document in order, as (name, text); the document
    /// must be well-formed XML.
    fn elements(xml: &str) -> Vec<(String, String)> {
        use quick_xml::Reader;
        use quick_xml::events::Event;
        let mut reader = Reader::from_str(xml);
        let mut open: Vec<String> = Vec::new();
        let mut found: Vec<(String, String)> = Vec::new();
        loop {
            match reader.read_event().expect("well-formed XML") {
                Event::Start(tag) => {
                    let name = tag.name().as_ref().to_owned();
                    found.push((name.clone(), String::new()));
                    open.push(name);
                }
                Event::Text(text) => {
                    if let Some(last) = found.last_mut() {
                        last.1.push_str(text.html_content().trim());
                    }
                }
                Event::End(_) => {
                    open.pop();
                }
                Event::Eof => break,
                _ => {}
            }
        }
        assert!(open.is_empty(), "unclosed elements: {open:?}");
        found
    }

    fn value_of<'a>(found: &'a [(String, String)], name: &str) -> Vec<&'a str> {
        found
            .iter()
            .filter(|(tag, _)| tag == name)
            .map(|(_, text)| text.as_str())
            .collect()
    }

    #[tokio::test]
    async fn a_batch_is_made_listed_downloaded_and_cancelled() {
        let Some(world) = World::new() else {
            return;
        };
        let co = company(&world.db, "NL91ABNA0417164300").await;
        let acme = supplier(&world.db, "Acme Trading B.V.", Some("NL02ABNA0123456789")).await;
        let zeta = supplier(&world.db, "Zeta GmbH", Some("DE89370400440532013000")).await;
        let b1 = bill(
            &world.db,
            &co.entity,
            &acme,
            &fresh("B"),
            "121.00",
            "approved",
            "EUR",
        )
        .await;
        let b2 = bill(
            &world.db,
            &co.entity,
            &zeta,
            &fresh("B"),
            "60.50",
            "overdue",
            "EUR",
        )
        .await;
        world.events().await;

        let (status, out) = make(
            &world,
            &co.entity,
            json!({ "bankAccountId": co.bank, "billIds": [b1, b2], "executionDate": tomorrow() }),
        )
        .await;
        assert_eq!(status, 201, "{out}");
        let batch = &out["data"];
        let id = field(batch, "id").to_owned();
        assert_eq!(field(batch, "status"), "exported");
        assert_eq!(field(batch, "totalAmount"), "181.50");
        assert_eq!(batch["paymentCount"], json!(2));
        assert_eq!(batch["billCount"], json!(2));
        assert_eq!(batch["bills"].as_array().unwrap().len(), 2);
        assert_eq!(batch["held"], json!([]));
        assert!(field(batch, "fileName").to_lowercase().ends_with(".xml"));
        let events = world.events().await;
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].0, "payment_batch.created");
        assert_eq!(events[0].1["paymentCount"], json!(2));

        // It is a payment run of method sepa, and the bills keep their status.
        let run = row_of(&world.db, "payment_runs", &id).await;
        assert_eq!(field(&run, "method"), "sepa");
        assert_eq!(field(&run, "status"), "exported");
        assert_eq!(
            field(&row_of(&world.db, "bills", &b1).await, "status"),
            "approved"
        );
        // The payment runs' own list does not show it.
        let (runs, ..) = super::super::runs::list_runs(
            &world.db,
            &co.entity,
            super::super::runs::ListRuns {
                status: None,
                method: None,
                bank_account_id: None,
                limit: 100,
                cursor: None,
            },
        )
        .await
        .unwrap();
        assert!(runs.iter().all(|r| r["id"] != json!(id)));

        // Listed, with its bills, and the bills show as waiting.
        let (status, out) = answer_of(list(world.caller(&co.entity)).await).await;
        assert_eq!(status, 200);
        let listed = out["data"].as_array().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(out["pagination"]["totalCount"], json!(1));
        assert_eq!(field(&listed[0], "status"), "exported");
        assert_eq!(listed[0]["paidBillCount"], json!(0));
        let (_, out) = answer_of(detail(world.caller(&co.entity), Path(id.clone())).await).await;
        assert_eq!(out["data"]["bills"].as_array().unwrap().len(), 2);
        assert_eq!(field(&out["data"]["bills"][0], "paid"), "");
        let (_, out) = answer_of(pending_bills(world.caller(&co.entity)).await).await;
        let waiting: Vec<&str> = out["data"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p["billId"].as_str().unwrap())
            .collect();
        assert_eq!(waiting.len(), 2);
        assert!(waiting.contains(&b1.as_str()) && waiting.contains(&b2.as_str()));
        assert_eq!(out["data"][0]["batchId"], json!(id));

        // A bill in an open batch is not in a second one.
        let (status, out) = make(
            &world,
            &co.entity,
            json!({ "bankAccountId": co.bank, "billIds": [b1], "executionDate": tomorrow() }),
        )
        .await;
        assert_eq!(status, 400, "{out}");
        assert_eq!(out["error"]["code"], json!("BILL_IN_OTHER_RUN"));

        // The file: pain.001, the right count and control sum, remittance and ids.
        let response = file(world.caller(&co.entity), Path(id.clone())).await;
        assert_eq!(response.status().as_u16(), 200);
        assert_eq!(
            response.headers()[header::CONTENT_TYPE],
            "application/xml; charset=utf-8"
        );
        assert!(
            response.headers()[header::CONTENT_DISPOSITION]
                .to_str()
                .unwrap()
                .contains(".xml")
        );
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let xml = String::from_utf8(bytes.to_vec()).unwrap();
        let found = elements(&xml);
        assert_eq!(value_of(&found, "NbOfTxs"), ["2", "2"]);
        assert_eq!(value_of(&found, "CtrlSum"), ["181.50", "181.50"]);
        assert_eq!(value_of(&found, "PmtMtd"), ["TRF"]);
        assert_eq!(value_of(&found, "ReqdExctnDt"), [tomorrow().as_str()]);
        assert_eq!(value_of(&found, "InstdAmt"), ["121.00", "60.50"]);
        let ibans = value_of(&found, "IBAN");
        assert_eq!(ibans.len(), 3);
        assert_eq!(ibans[0], "NL91ABNA0417164300");
        assert!(ibans.contains(&"NL02ABNA0123456789") && ibans.contains(&"DE89370400440532013000"));
        assert_eq!(value_of(&found, "Ustrd").len(), 2);
        assert!(value_of(&found, "Ustrd")[0].starts_with("INV-"));
        assert_eq!(value_of(&found, "CdtTrfTxInf").len(), 2);
        // The same bytes every time.
        let again = file(world.caller(&co.entity), Path(id.clone())).await;
        let again = axum::body::to_bytes(again.into_body(), usize::MAX)
            .await
            .unwrap();
        assert_eq!(again.to_vec(), bytes.to_vec());

        // One bill is paid by its bank line: waiting for the other; both: completed.
        sqlx::query(
            "update bills set status = 'paid', balance_due = 0, amount_paid = total where id = $1",
        )
        .bind(&b1)
        .execute(&world.db)
        .await
        .unwrap();
        let (_, out) = answer_of(detail(world.caller(&co.entity), Path(id.clone())).await).await;
        assert_eq!(out["data"]["paidBillCount"], json!(1));
        assert_eq!(field(&out["data"], "status"), "exported");
        let (_, out) = answer_of(pending_bills(world.caller(&co.entity)).await).await;
        assert_eq!(out["data"].as_array().unwrap().len(), 1);
        sqlx::query(
            "update bills set status = 'paid', balance_due = 0, amount_paid = total where id = $1",
        )
        .bind(&b2)
        .execute(&world.db)
        .await
        .unwrap();
        let (_, out) = answer_of(detail(world.caller(&co.entity), Path(id.clone())).await).await;
        assert_eq!(field(&out["data"], "status"), "completed");
        let (status, out) = answer_of(
            cancel(
                world.caller(&co.entity),
                State(world.state.clone()),
                Path(id.clone()),
            )
            .await,
        )
        .await;
        assert_eq!(status, 400, "{out}");
        assert_eq!(out["error"]["code"], json!("BATCH_NOT_CANCELLABLE"));

        // Cancelling releases the bills: they can go in a new batch.
        let b3 = bill(
            &world.db,
            &co.entity,
            &acme,
            &fresh("B"),
            "10.00",
            "approved",
            "EUR",
        )
        .await;
        let (_, out) = make(
            &world,
            &co.entity,
            json!({ "bankAccountId": co.bank, "billIds": [b3], "executionDate": tomorrow() }),
        )
        .await;
        let second = field(&out["data"], "id").to_owned();
        world.events().await;
        let (status, out) = answer_of(
            cancel(
                world.caller(&co.entity),
                State(world.state.clone()),
                Path(second.clone()),
            )
            .await,
        )
        .await;
        assert_eq!(status, 200, "{out}");
        assert_eq!(field(&out["data"], "status"), "cancelled");
        let events = world.events().await;
        assert_eq!(
            events.iter().map(|e| e.0.as_str()).collect::<Vec<_>>(),
            ["payment_batch.cancelled"]
        );
        let (_, out) = answer_of(pending_bills(world.caller(&co.entity)).await).await;
        assert!(out["data"].as_array().unwrap().is_empty());
        let response = file(world.caller(&co.entity), Path(second.clone())).await;
        assert_eq!(response.status().as_u16(), 400);
        let (status, _) = answer_of(
            cancel(
                world.caller(&co.entity),
                State(world.state.clone()),
                Path(second),
            )
            .await,
        )
        .await;
        assert_eq!(status, 400, "cancelling twice is refused");
        let (status, out) = make(
            &world,
            &co.entity,
            json!({ "bankAccountId": co.bank, "billIds": [b3], "executionDate": tomorrow() }),
        )
        .await;
        assert_eq!(status, 201, "{out}");
    }

    #[tokio::test]
    async fn a_bill_waiting_for_its_bank_line_still_matches_it() {
        use weldsuite_books_domain::bank_matching::{
            DocumentShare, find_matches, reconcile_to_documents,
        };
        let Some(world) = World::new() else {
            return;
        };
        let co = company(&world.db, "NL91ABNA0417164300").await;
        let acme = supplier(&world.db, "Acme Trading B.V.", Some("NL02ABNA0123456789")).await;
        let number = fresh("B");
        let due = bill(
            &world.db, &co.entity, &acme, &number, "121.00", "approved", "EUR",
        )
        .await;
        let (status, out) = make(
            &world,
            &co.entity,
            json!({ "bankAccountId": co.bank, "billIds": [due], "executionDate": tomorrow() }),
        )
        .await;
        assert_eq!(status, 201, "{out}");
        let id = field(&out["data"], "id").to_owned();

        // The bank carries out the transfer; the line comes in with the bill
        // number as the end-to-end id, and the matcher offers the bill.
        let line = fresh("btx");
        sqlx::query(
            "insert into bank_transactions (id, entity_id, bank_account_id, date, amount, description, \
               counterparty_name, counterparty_iban, end_to_end_id, status) \
             values ($1, $2, $3, now(), -121.00, $4, 'Acme Trading B.V.', 'NL02ABNA0123456789', $5, 'unreconciled')",
        )
        .bind(&line)
        .bind(&co.entity)
        .bind(&co.bank)
        .bind(format!("INV-{number}"))
        .bind(&number)
        .execute(&world.db)
        .await
        .unwrap();
        let row = weldsuite_books_domain::tables::BANK_TRANSACTIONS
            .find_live(&world.db, &line)
            .await
            .unwrap()
            .unwrap();
        let found = find_matches(&world.db, &row, None).await.unwrap();
        let best = found.first().expect("the matcher offers the bill");
        assert_eq!((best.kind, best.entity_id.as_str()), ("bill", due.as_str()));
        assert!(best.confidence >= 0.8, "{}", best.confidence);

        // Linked as usual: the bill is paid and the batch has one bill less to wait for.
        reconcile_to_documents(
            &world.db,
            None,
            &row,
            &[DocumentShare {
                invoice: false,
                id: due.clone(),
                amount: 121.0,
            }],
            None,
            Some("user_p3".to_owned()),
        )
        .await
        .unwrap();
        assert_eq!(
            field(&row_of(&world.db, "bills", &due).await, "status"),
            "paid"
        );
        let (_, out) = answer_of(detail(world.caller(&co.entity), Path(id)).await).await;
        assert_eq!(field(&out["data"], "status"), "completed");
        assert_eq!(out["data"]["paidBillCount"], json!(1));
        let (_, out) = answer_of(pending_bills(world.caller(&co.entity)).await).await;
        assert!(out["data"].as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn what_cannot_be_paid_is_refused_and_another_entity_sees_nothing() {
        let Some(world) = World::new() else {
            return;
        };
        let co = company(&world.db, "NL91ABNA0417164300").await;
        let other = company(&world.db, "NL12ABNA0000000002").await;
        let acme = supplier(&world.db, "Acme", Some("NL02ABNA0123456789")).await;
        let nameless = supplier(&world.db, "No IBAN", None).await;
        let draft = bill(
            &world.db,
            &co.entity,
            &acme,
            &fresh("B"),
            "5.00",
            "draft",
            "EUR",
        )
        .await;
        let dollars = bill(
            &world.db,
            &co.entity,
            &acme,
            &fresh("B"),
            "5.00",
            "approved",
            "USD",
        )
        .await;
        let loose = bill(
            &world.db,
            &co.entity,
            &nameless,
            &fresh("B"),
            "5.00",
            "approved",
            "EUR",
        )
        .await;
        let theirs = bill(
            &world.db,
            &other.entity,
            &acme,
            &fresh("B"),
            "5.00",
            "approved",
            "EUR",
        )
        .await;
        let good = bill(
            &world.db,
            &co.entity,
            &acme,
            &fresh("B"),
            "5.00",
            "approved",
            "EUR",
        )
        .await;

        for (ids, code) in [
            (vec![&draft], "BILL_NOT_PAYABLE"),
            (vec![&dollars], "BILL_CURRENCY"),
            (vec![&loose], "NO_IBAN"),
            (vec![&theirs], "BILL_OTHER_ENTITY"),
            (vec![&good, &good], "DUPLICATE_BILL"),
        ] {
            let (status, out) = make(
                &world,
                &co.entity,
                json!({ "bankAccountId": co.bank, "billIds": ids, "executionDate": tomorrow() }),
            )
            .await;
            assert_eq!(status, 400, "{code}: {out}");
            assert_eq!(out["error"]["code"], json!(code), "{out}");
        }
        // The date: not in the past, and a real one.
        for (date, code) in [
            ("2020-01-01", "EXECUTION_DATE_PAST"),
            ("2026-13-45", "INVALID_DATE"),
        ] {
            let (status, out) = make(
                &world,
                &co.entity,
                json!({ "bankAccountId": co.bank, "billIds": [good], "executionDate": date }),
            )
            .await;
            assert_eq!(status, 400, "{out}");
            assert_eq!(out["error"]["code"], json!(code));
        }
        // A bank account without a valid IBAN cannot pay by SEPA.
        sqlx::query("update bank_accounts set iban = 'nonsense' where id = $1")
            .bind(&co.bank)
            .execute(&world.db)
            .await
            .unwrap();
        let (status, out) = make(
            &world,
            &co.entity,
            json!({ "bankAccountId": co.bank, "billIds": [good], "executionDate": tomorrow() }),
        )
        .await;
        assert_eq!(status, 400, "{out}");
        assert_eq!(out["error"]["code"], json!("BANK_ACCOUNT_IBAN"));
        sqlx::query("update bank_accounts set iban = 'NL91ABNA0417164300' where id = $1")
            .bind(&co.bank)
            .execute(&world.db)
            .await
            .unwrap();
        // A body that is not one.
        let (status, _) = make(
            &world,
            &co.entity,
            json!({ "billIds": [], "executionDate": "x" }),
        )
        .await;
        assert_eq!(status, 400);
        // Nothing was made by any of that.
        let made: i64 = sqlx::query_scalar(
            "select count(*) from payment_runs where entity_id = $1 and method = 'sepa'",
        )
        .bind(&co.entity)
        .fetch_one(&world.db)
        .await
        .unwrap();
        assert_eq!(made, 0);

        // A batch of this entity is not found, listed or paid out by another's.
        let (status, out) = make(
            &world,
            &co.entity,
            json!({ "bankAccountId": co.bank, "billIds": [good], "executionDate": tomorrow() }),
        )
        .await;
        assert_eq!(status, 201, "{out}");
        let id = field(&out["data"], "id").to_owned();
        let (status, _) =
            answer_of(detail(world.caller(&other.entity), Path(id.clone())).await).await;
        assert_eq!(status, 404);
        let response = file(world.caller(&other.entity), Path(id.clone())).await;
        assert_eq!(response.status().as_u16(), 404);
        let (status, _) = answer_of(
            cancel(
                world.caller(&other.entity),
                State(world.state.clone()),
                Path(id.clone()),
            )
            .await,
        )
        .await;
        assert_eq!(status, 404);
        let (_, out) = answer_of(list(world.caller(&other.entity)).await).await;
        assert!(out["data"].as_array().unwrap().is_empty());
        let (_, out) = answer_of(pending_bills(world.caller(&other.entity)).await).await;
        assert!(out["data"].as_array().unwrap().is_empty());
        let (status, _) = make(
            &world,
            &other.entity,
            json!({ "bankAccountId": co.bank, "billIds": [theirs], "executionDate": tomorrow() }),
        )
        .await;
        assert_eq!(status, 404, "another entity's bank account is not found");
        let _ = answer;
    }

    #[tokio::test]
    async fn a_supplier_whose_bank_details_changed_is_held() {
        let Some(world) = World::new() else {
            return;
        };
        let co = company(&world.db, "NL91ABNA0417164300").await;
        let steady = supplier(&world.db, "Steady", Some("NL02ABNA0123456789")).await;
        let changed = supplier(&world.db, "Changed", Some("DE89370400440532013000")).await;
        sqlx::query(
            "update parties set bank_details_changed_at = now() - interval '2 days' where id = $1",
        )
        .bind(&changed)
        .execute(&world.db)
        .await
        .unwrap();
        let ok_bill = bill(
            &world.db,
            &co.entity,
            &steady,
            &fresh("B"),
            "10.00",
            "approved",
            "EUR",
        )
        .await;
        let held_bill = bill(
            &world.db,
            &co.entity,
            &changed,
            &fresh("B"),
            "20.00",
            "approved",
            "EUR",
        )
        .await;

        // The held supplier is left out, and told so; the rest is paid.
        let (status, out) = make(
            &world,
            &co.entity,
            json!({ "bankAccountId": co.bank, "billIds": [ok_bill, held_bill], "executionDate": tomorrow() }),
        )
        .await;
        assert_eq!(status, 201, "{out}");
        assert_eq!(out["data"]["paymentCount"], json!(1));
        assert_eq!(field(&out["data"], "totalAmount"), "10.00");
        assert_eq!(out["data"]["bills"].as_array().unwrap().len(), 1);
        let held = out["data"]["held"].as_array().unwrap();
        assert_eq!(held.len(), 1);
        assert_eq!(field(&held[0], "code"), "bank_details_changed");
        assert_eq!(field(&held[0], "contactName"), "Changed");
        let id = field(&out["data"], "id").to_owned();
        let (_, detail_out) = answer_of(detail(world.caller(&co.entity), Path(id)).await).await;
        assert_eq!(detail_out["data"]["heldCount"], json!(1));
        // The held bill is not waiting for the bank, it was never sent.
        let (_, out) = answer_of(pending_bills(world.caller(&co.entity)).await).await;
        assert_eq!(out["data"].as_array().unwrap().len(), 1);

        // Only held suppliers: nothing to pay.
        let (status, out) = make(
            &world,
            &co.entity,
            json!({ "bankAccountId": co.bank, "billIds": [held_bill], "executionDate": tomorrow() }),
        )
        .await;
        assert_eq!(status, 400, "{out}");
        assert_eq!(out["error"]["code"], json!("ALL_HELD"));
        // Verified on the supplier, it goes.
        sqlx::query("update parties set bank_details_verified_at = now() where id = $1")
            .bind(&changed)
            .execute(&world.db)
            .await
            .unwrap();
        let (status, out) = make(
            &world,
            &co.entity,
            json!({ "bankAccountId": co.bank, "billIds": [held_bill], "executionDate": tomorrow() }),
        )
        .await;
        assert_eq!(status, 201, "{out}");

        // A new IBAN after a batch paid the old one holds until verified.
        sqlx::query("update parties set iban = 'NL86INGB0002445588' where id = $1")
            .bind(&steady)
            .execute(&world.db)
            .await
            .unwrap();
        let next = bill(
            &world.db,
            &co.entity,
            &steady,
            &fresh("B"),
            "11.00",
            "approved",
            "EUR",
        )
        .await;
        let (status, out) = make(
            &world,
            &co.entity,
            json!({ "bankAccountId": co.bank, "billIds": [next], "executionDate": tomorrow() }),
        )
        .await;
        assert_eq!(status, 400, "{out}");
        assert_eq!(out["error"]["code"], json!("ALL_HELD"));
        assert!(out["error"]["message"].as_str().unwrap().contains("IBAN"));
        sqlx::query("update parties set bank_details_verified_at = now() + interval '1 minute' where id = $1")
            .bind(&steady)
            .execute(&world.db)
            .await
            .unwrap();
        let (status, out) = make(
            &world,
            &co.entity,
            json!({ "bankAccountId": co.bank, "billIds": [next], "executionDate": tomorrow() }),
        )
        .await;
        assert_eq!(status, 201, "{out}");
    }
}
