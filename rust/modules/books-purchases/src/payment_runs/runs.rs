//! Payment runs (`services/payment-runs/runs.ts` and `withholding.ts`): the
//! plan of a batch of vendor payments before and while it is approved.
//!
//! `draft -> pending_approval -> approved -> exported -> completed`, with
//! `cancelled` from draft or pending; a rejected run goes back to draft. Holds
//! keep single vendors out of the payments without stopping the run.

use std::collections::HashMap;

use base64::Engine;
use serde_json::{Map, Value, json};
use sqlx::PgPool;
use weldsuite_books_domain::address::format_postal_address_lines;
use weldsuite_books_domain::backup_withholding::{
    BACKUP_WITHHOLDING_RATE, BackupWithholdingOutcome, ComputeBackupWithholdingInput,
    compute_backup_withholding,
};
use weldsuite_books_domain::entity_context::resolve_entity_base_currency;
use weldsuite_books_domain::http::{now, now_ms};
use weldsuite_books_domain::js::{
    js_date_millis, locale_compare, millis_of, parse_float, parse_int, round_money, to_fixed,
};
use weldsuite_books_domain::payments::payment_net_amount;
use weldsuite_books_domain::posting::{account_for_role, load_entity_accounts};
use weldsuite_books_domain::tables::{AUDIT_LOG, BILLS, PAYMENT_RUNS, PAYMENTS};
use weldsuite_kit::generate_id;
use weldsuite_kit::validation::Field;

use super::holds::{
    AchHistory, EvaluateHolds, RunHold, active_holds, decode_holds, encode_holds, evaluate_holds,
    held_party_ids, load_ach_history, load_parties, party_ids_of, prenote_state, release_blocker,
    vendor_ach_status,
};
use super::settings::{ACH_SEC_CODES, DEFAULT_HOLD_WINDOW_DAYS, read_ach_settings};
use super::{RunError, bad, load_bank_account, not_found, run_error};

/// Bill statuses a run may pay.
pub(crate) const PAYABLE_BILL_STATUSES: [&str; 3] = ["approved", "partial", "overdue"];
pub(crate) const OPEN_RUN_STATUSES: [&str; 2] = ["draft", "pending_approval"];

pub(crate) fn text<'a>(row: &'a Value, key: &str) -> Option<&'a str> {
    row.get(key).and_then(Value::as_str)
}

pub(crate) fn s<'a>(row: &'a Value, key: &str) -> &'a str {
    text(row, key).unwrap_or_default()
}

/// A run's bill: `{ billId, amount, partyId }`.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct RunItem {
    pub bill_id: String,
    pub amount: f64,
    pub party_id: String,
}

/// `run.items ?? []`.
pub(crate) fn items_of(value: Option<&Value>) -> Vec<RunItem> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|item| RunItem {
                    bill_id: s(item, "billId").to_owned(),
                    amount: item
                        .get("amount")
                        .map_or(f64::NAN, weldsuite_books_domain::js::numeric),
                    party_id: s(item, "partyId").to_owned(),
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The items as `JSON.stringify` stores them.
pub(crate) fn items_json(items: &[RunItem]) -> Value {
    Value::Array(
        items
            .iter()
            .map(|i| {
                json!({
                    "billId": i.bill_id,
                    "amount": weldsuite_books_domain::js::number_value(i.amount),
                    "partyId": i.party_id,
                })
            })
            .collect(),
    )
}

/// `run.approvals ?? []`.
pub(crate) fn approvals_of(run: &Value) -> Vec<Value> {
    run.get("approvals")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

pub(crate) fn required_approvals(run: &Value) -> i64 {
    run.get("requiredApprovals")
        .and_then(Value::as_i64)
        .unwrap_or(0)
}

// ── Loading ─────────────────────────────────────────────────────────────────

/// `loadRun(db, entityId, runId)`.
pub(crate) async fn load_run(
    db: &PgPool,
    entity_id: &str,
    run_id: &str,
) -> Result<Value, RunError> {
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(payment_runs),
        " from payment_runs t where t.id = $1 and t.entity_id = $2 and t.deleted_at is null limit 1"
    ))
    .bind(run_id)
    .bind(entity_id)
    .fetch_optional(db)
    .await?;
    row.map(|row| PAYMENT_RUNS.js(row))
        .ok_or_else(|| not_found("Payment run", run_id))
}

/// A run row by id (any entity, deleted ones too).
pub(crate) async fn find_run(db: &PgPool, run_id: &str) -> Result<Option<Value>, sqlx::Error> {
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(payment_runs),
        " from payment_runs t where t.id = $1 limit 1"
    ))
    .bind(run_id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(|row| PAYMENT_RUNS.js(row)))
}

/// `assertStatus(run, allowed, action)`.
pub(crate) fn assert_status(run: &Value, allowed: &[&str], action: &str) -> Result<(), RunError> {
    let status = s(run, "status");
    if allowed.contains(&status) {
        return Ok(());
    }
    Err(run_error(
        "INVALID_STATE",
        format!("A {} run can't be {action}.", status.replace('_', " ")),
        409,
        Some(json!({ "status": status })),
    ))
}

fn changed_meanwhile(doing: &str) -> RunError {
    run_error(
        "INVALID_STATE",
        format!("The run changed while you were {doing} it. Reload it and try again."),
        409,
        None,
    )
}

// ── Items ───────────────────────────────────────────────────────────────────

/// `resolveItems(db, entityId, input)`: the bills and amounts checked, each
/// with its vendor.
pub(crate) async fn resolve_items(
    db: &PgPool,
    entity_id: &str,
    input: &[(String, f64)],
) -> Result<Vec<RunItem>, RunError> {
    if input.is_empty() {
        return Err(bad(
            "NO_ITEMS",
            "A payment run needs at least one bill.",
            None,
        ));
    }
    let ids: Vec<String> = input.iter().map(|(id, _)| id.clone()).collect();
    let mut unique = ids.clone();
    unique.sort();
    unique.dedup();
    if unique.len() != ids.len() {
        return Err(bad(
            "DUPLICATE_BILL",
            "A bill can only be in a run once.",
            None,
        ));
    }
    let rows: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(bills),
        " from bills t where t.id = any($1) and t.deleted_at is null"
    ))
    .bind(&ids)
    .fetch_all(db)
    .await?;
    let bills = BILLS.js_rows(rows);
    let base = resolve_entity_base_currency(db, entity_id).await?;
    let mut items = Vec::with_capacity(input.len());
    for (bill_id, amount) in input {
        let Some(bill) = bills.iter().find(|b| s(b, "id") == bill_id) else {
            return Err(bad(
                "BILL_NOT_FOUND",
                &format!("Bill {bill_id} not found."),
                Some(json!({ "billId": bill_id })),
            ));
        };
        let id = s(bill, "id");
        let label = text(bill, "billNumber").unwrap_or(id);
        let details = Some(json!({ "billId": id }));
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
                &format!("Bill {label} is {status} and can't be paid in a run."),
                details,
            ));
        }
        let currency = text(bill, "currency").unwrap_or(base.as_str());
        if currency != base {
            return Err(bad(
                "BILL_CURRENCY",
                &format!("Bill {label} is in {currency}: payment runs pay {base} bills only."),
                details,
            ));
        }
        let amount = round_money(*amount);
        if amount.is_nan() || amount <= 0.0 {
            return Err(bad(
                "INVALID_AMOUNT",
                &format!("The amount for bill {label} must be greater than zero."),
                details,
            ));
        }
        let open = parse_float(text(bill, "balanceDue").unwrap_or("0"));
        if amount > open + 0.005 {
            return Err(bad(
                "AMOUNT_EXCEEDS_BALANCE",
                &format!(
                    "The amount for bill {label} ({}) is more than its open balance ({}).",
                    to_fixed(amount, 2),
                    to_fixed(open, 2)
                ),
                Some(json!({ "billId": id, "balanceDue": to_fixed(open, 2) })),
            ));
        }
        items.push(RunItem {
            bill_id: id.to_owned(),
            amount,
            party_id: s(bill, "contactId").to_owned(),
        });
    }
    Ok(items)
}

/// `totalsOf(items, holds)`: what the run pays, held vendors left out.
#[derive(Debug, Clone)]
pub(crate) struct Totals {
    pub total_amount: String,
    pub held_amount: String,
    pub payment_count: i64,
}

pub(crate) fn totals_of(items: &[RunItem], holds: &[RunHold]) -> Totals {
    let held = held_party_ids(holds);
    let mut total = 0.0;
    let mut held_total = 0.0;
    let mut payees: Vec<&str> = Vec::new();
    for item in items {
        if held.contains(&item.party_id) {
            held_total = round_money(held_total + item.amount);
        } else {
            total = round_money(total + item.amount);
            if !payees.contains(&item.party_id.as_str()) {
                payees.push(&item.party_id);
            }
        }
    }
    Totals {
        total_amount: to_fixed(total, 2),
        held_amount: to_fixed(held_total, 2),
        payment_count: i64::try_from(payees.len()).unwrap_or(0),
    }
}

// ── Backup withholding (withholding.ts) ─────────────────────────────────────

/// `VendorWithholding`.
#[derive(Debug, Clone, Copy)]
pub(crate) struct VendorWithholding {
    pub amount: f64,
    pub reason: Option<&'static str>,
    pub rate: f64,
    pub gross: f64,
}

/// `computeRunWithholding(db, args)`: the vendors withholding applies to,
/// in the order of `parties`.
pub(crate) async fn compute_run_withholding(
    db: &PgPool,
    entity_id: &str,
    ach: bool,
    payment_date: &str,
    items: &[RunItem],
    parties: &[Value],
) -> Result<Vec<(String, VendorWithholding)>, sqlx::Error> {
    let mut result = Vec::new();
    for party in parties {
        if !weldsuite_books_domain::js::truthy(party.get("is1099Vendor")) {
            continue;
        }
        let id = s(party, "id");
        let gross = items
            .iter()
            .filter(|i| i.party_id == id)
            .fold(0.0, |sum, i| round_money(sum + i.amount));
        if gross.is_nan() || gross <= 0.0 {
            continue;
        }
        let outcome: BackupWithholdingOutcome = compute_backup_withholding(
            db,
            ComputeBackupWithholdingInput {
                entity_id,
                party_id: id,
                gross_amount: gross,
                day: payment_date.get(..10).unwrap_or(payment_date),
                payment_method: Some(if ach { "ach" } else { "check" }),
                ..ComputeBackupWithholdingInput::default()
            },
        )
        .await?;
        if outcome.amount > 0.0 {
            result.push((
                id.to_owned(),
                VendorWithholding {
                    amount: outcome.amount,
                    reason: outcome.reason,
                    rate: outcome.rate,
                    gross,
                },
            ));
        }
    }
    Ok(result)
}

/// `hasBackupWithholdingAccount(db, entityId)`.
pub(crate) async fn has_backup_withholding_account(
    db: &PgPool,
    entity_id: &str,
) -> Result<bool, sqlx::Error> {
    let accounts = load_entity_accounts(db, entity_id).await?;
    Ok(account_for_role(&accounts, "backup_withholding_payable", &["2310"]).is_some())
}

// ── Create and edit ─────────────────────────────────────────────────────────

/// `validateAchOptions(method, { secCode, sameDay }, bank)`.
fn validate_ach_options(
    ach: bool,
    sec_code: Option<&str>,
    same_day: bool,
    bank: &Value,
) -> Result<(), RunError> {
    let sec_code = sec_code.filter(|c| !c.is_empty());
    if !ach {
        if sec_code.is_some() || same_day {
            return Err(bad(
                "ACH_ONLY",
                "An SEC code and Same Day ACH apply to ACH runs only.",
                None,
            ));
        }
        return Ok(());
    }
    if let Some(code) = sec_code
        && !ACH_SEC_CODES.contains(&code)
    {
        return Err(bad(
            "INVALID_SEC_CODE",
            &format!("SEC code {code} isn't supported: use PPD, CCD, CCD+ or CTX."),
            None,
        ));
    }
    if same_day && !read_ach_settings(bank.get("achSettings")).same_day_allowed {
        return Err(bad(
            "SAME_DAY_NOT_ALLOWED",
            "Same Day ACH is off for this bank account. Turn it on in the ACH settings first.",
            None,
        ));
    }
    Ok(())
}

fn has_check_number(bank: &Value) -> bool {
    bank.get("nextCheckNumber").is_some_and(|n| !n.is_null())
}

fn check_number_required() -> RunError {
    bad(
        "CHECK_NUMBER_REQUIRED",
        "Set the next check number in the bank account's check settings before paying by check.",
        None,
    )
}

fn approvals_require_manage() -> RunError {
    run_error(
        "APPROVALS_REQUIRE_MANAGE",
        "Paying by ACH with fewer than two approvals needs the banking:manage permission."
            .to_owned(),
        403,
        None,
    )
}

/// `CreateRunInput`.
pub(crate) struct CreateRun {
    pub user_id: String,
    pub bank_account_id: String,
    pub ach: bool,
    pub payment_date: String,
    pub sec_code: Option<String>,
    pub same_day: bool,
    pub items: Vec<(String, f64)>,
    pub required_approvals: Option<i64>,
    pub notes: Option<String>,
    pub can_lower_approvals: bool,
}

/// `createRun(db, input)`: the run and whether its approvals were lowered.
pub(crate) async fn create_run(
    db: &PgPool,
    entity_id: &str,
    input: CreateRun,
) -> Result<(Value, bool), RunError> {
    let bank = load_bank_account(db, entity_id, &input.bank_account_id).await?;
    if bank.get("isActive") == Some(&Value::Bool(false)) {
        return Err(bad(
            "BANK_ACCOUNT_INACTIVE",
            "This bank account is inactive.",
            None,
        ));
    }
    validate_ach_options(input.ach, input.sec_code.as_deref(), input.same_day, &bank)?;
    if !input.ach && !has_check_number(&bank) {
        return Err(check_number_required());
    }
    let required = input
        .required_approvals
        .unwrap_or(if input.ach { 2 } else { 1 });
    let lowered = input.ach && required < 2;
    if lowered && !input.can_lower_approvals {
        return Err(approvals_require_manage());
    }
    let items = resolve_items(db, entity_id, &input.items).await?;
    let ach = read_ach_settings(bank.get("achSettings"));
    let holds = evaluate_holds(
        db,
        EvaluateHolds {
            entity_id,
            run_id: None,
            ach: input.ach,
            payment_date: &input.payment_date,
            items: &items,
            settings: &ach,
            previous: &[],
        },
    )
    .await?;
    let totals = totals_of(&items, &holds);
    let at = now();
    let row: Value = sqlx::query_scalar(concat!(
        "insert into payment_runs as t (id, entity_id, bank_account_id, method, status, payment_date, sec_code, same_day, \
         total_amount, payment_count, required_approvals, approvals, items, holds, created_by, notes, created_at, updated_at) \
         values ($1, $2, $3, $4, 'draft', $5::date, $6, $7, $8::numeric, $9, $10, '[]'::jsonb, $11, $12, $13, $14, $15::timestamp, $15::timestamp) \
         returning ",
        weldsuite_books_domain::books_row!(payment_runs)
    ))
    .bind(generate_id("prn"))
    .bind(entity_id)
    .bind(s(&bank, "id"))
    .bind(if input.ach { "ach" } else { "check" })
    .bind(&input.payment_date)
    .bind(if input.ach { input.sec_code.clone() } else { None })
    .bind(input.ach && input.same_day)
    .bind(&totals.total_amount)
    .bind(totals.payment_count)
    .bind(required)
    .bind(items_json(&items))
    .bind(encode_holds(&holds))
    .bind(&input.user_id)
    .bind(&input.notes)
    .bind(&at)
    .fetch_one(db)
    .await?;
    Ok((PAYMENT_RUNS.js(row), lowered))
}

/// `UpdateRunInput`: absent fields keep the run's value.
pub(crate) struct UpdateRun {
    pub payment_date: Option<String>,
    /// `undefined` keeps, `null` clears.
    pub sec_code: Field<String>,
    pub same_day: Option<bool>,
    pub items: Option<Vec<(String, f64)>>,
    pub required_approvals: Option<i64>,
    pub notes: Field<String>,
    pub bank_account_id: Option<String>,
    pub can_lower_approvals: bool,
}

/// `updateRun(db, input)`: the run after and before.
pub(crate) async fn update_run(
    db: &PgPool,
    entity_id: &str,
    run_id: &str,
    input: UpdateRun,
) -> Result<(Value, Value), RunError> {
    let before = load_run(db, entity_id, run_id).await?;
    assert_status(
        &before,
        &["draft"],
        "edited (reject or cancel it, or start a new one)",
    )?;
    let bank_account_id = input
        .bank_account_id
        .clone()
        .unwrap_or_else(|| s(&before, "bankAccountId").to_owned());
    let bank = load_bank_account(db, entity_id, &bank_account_id).await?;
    let ach = s(&before, "method") == "ach";
    let sec_code = match input.sec_code {
        Field::Set(code) => Some(code),
        Field::Null => None,
        Field::Absent => text(&before, "secCode").map(str::to_owned),
    };
    let same_day = input
        .same_day
        .unwrap_or_else(|| before.get("sameDay") == Some(&Value::Bool(true)));
    validate_ach_options(ach, sec_code.as_deref(), same_day, &bank)?;
    if !ach && !has_check_number(&bank) {
        return Err(check_number_required());
    }
    let required = input
        .required_approvals
        .unwrap_or_else(|| required_approvals(&before));
    if ach && required < 2 && required != required_approvals(&before) && !input.can_lower_approvals
    {
        return Err(approvals_require_manage());
    }
    let items = match &input.items {
        Some(items) => resolve_items(db, entity_id, items).await?,
        None => items_of(before.get("items")),
    };
    let payment_date = input
        .payment_date
        .clone()
        .unwrap_or_else(|| s(&before, "paymentDate").to_owned());
    let previous = decode_holds(before.get("holds"));
    let holds = evaluate_holds(
        db,
        EvaluateHolds {
            entity_id,
            run_id: Some(s(&before, "id")),
            ach,
            payment_date: &payment_date,
            items: &items,
            settings: &read_ach_settings(bank.get("achSettings")),
            previous: &previous,
        },
    )
    .await?;
    let totals = totals_of(&items, &holds);
    let notes = match input.notes {
        Field::Set(notes) => Some(notes),
        Field::Null => None,
        Field::Absent => text(&before, "notes").map(str::to_owned),
    };
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "update payment_runs t set bank_account_id = $2, payment_date = $3::date, sec_code = $4, same_day = $5, \
         required_approvals = $6, notes = $7, items = $8, holds = $9, total_amount = $10::numeric, payment_count = $11, \
         updated_at = $12::timestamp where t.id = $1 and t.status = 'draft' returning ",
        weldsuite_books_domain::books_row!(payment_runs)
    ))
    .bind(s(&before, "id"))
    .bind(&bank_account_id)
    .bind(&payment_date)
    .bind(if ach { sec_code } else { None })
    .bind(ach && same_day)
    .bind(required)
    .bind(&notes)
    .bind(items_json(&items))
    .bind(encode_holds(&holds))
    .bind(&totals.total_amount)
    .bind(totals.payment_count)
    .bind(now())
    .fetch_optional(db)
    .await?;
    let Some(run) = row.map(|row| PAYMENT_RUNS.js(row)) else {
        return Err(changed_meanwhile("editing"));
    };
    Ok((run, before))
}

/// `refreshHolds(db, run, bank)`: the holds worked out again and stored with
/// the new totals.
pub(crate) async fn refresh_holds(
    db: &PgPool,
    run: &Value,
    bank: Option<&Value>,
) -> Result<(Value, Vec<RunHold>), RunError> {
    let entity_id = s(run, "entityId");
    let account = match bank {
        Some(bank) => bank.clone(),
        None => load_bank_account(db, entity_id, s(run, "bankAccountId")).await?,
    };
    let items = items_of(run.get("items"));
    let previous = decode_holds(run.get("holds"));
    let holds = evaluate_holds(
        db,
        EvaluateHolds {
            entity_id,
            run_id: Some(s(run, "id")),
            ach: s(run, "method") == "ach",
            payment_date: s(run, "paymentDate"),
            items: &items,
            settings: &read_ach_settings(account.get("achSettings")),
            previous: &previous,
        },
    )
    .await?;
    let totals = totals_of(&items, &holds);
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "update payment_runs t set holds = $2, total_amount = $3::numeric, payment_count = $4, updated_at = $5::timestamp \
         where t.id = $1 returning ",
        weldsuite_books_domain::books_row!(payment_runs)
    ))
    .bind(s(run, "id"))
    .bind(encode_holds(&holds))
    .bind(&totals.total_amount)
    .bind(totals.payment_count)
    .bind(now())
    .fetch_optional(db)
    .await?;
    Ok((
        row.map_or_else(|| run.clone(), |row| PAYMENT_RUNS.js(row)),
        holds,
    ))
}

fn input_items(items: &[RunItem]) -> Vec<(String, f64)> {
    items
        .iter()
        .map(|i| (i.bill_id.clone(), i.amount))
        .collect()
}

/// `submitRun(db, entityId, runId)`.
pub(crate) async fn submit_run(
    db: &PgPool,
    entity_id: &str,
    run_id: &str,
) -> Result<Value, RunError> {
    let run = load_run(db, entity_id, run_id).await?;
    assert_status(&run, &["draft"], "submitted")?;
    let items = items_of(run.get("items"));
    if items.is_empty() {
        return Err(bad(
            "NO_ITEMS",
            "A payment run needs at least one bill.",
            None,
        ));
    }
    // Bills may have been paid or edited since the draft was made.
    resolve_items(db, entity_id, &input_items(&items)).await?;
    refresh_holds(db, &run, None).await?;
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "update payment_runs t set status = 'pending_approval', approvals = '[]'::jsonb, updated_at = $2::timestamp \
         where t.id = $1 and t.status = 'draft' returning ",
        weldsuite_books_domain::books_row!(payment_runs)
    ))
    .bind(s(&run, "id"))
    .bind(now())
    .fetch_optional(db)
    .await?;
    row.map(|row| PAYMENT_RUNS.js(row))
        .ok_or_else(|| changed_meanwhile("submitting"))
}

/// `rejectRun(db, entityId, runId)`: back to draft, approvals cleared.
pub(crate) async fn reject_run(
    db: &PgPool,
    entity_id: &str,
    run_id: &str,
) -> Result<Value, RunError> {
    let run = load_run(db, entity_id, run_id).await?;
    assert_status(&run, &["pending_approval"], "rejected")?;
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "update payment_runs t set status = 'draft', approvals = '[]'::jsonb, updated_at = $2::timestamp \
         where t.id = $1 and t.status = 'pending_approval' returning ",
        weldsuite_books_domain::books_row!(payment_runs)
    ))
    .bind(s(&run, "id"))
    .bind(now())
    .fetch_optional(db)
    .await?;
    row.map(|row| PAYMENT_RUNS.js(row))
        .ok_or_else(|| changed_meanwhile("rejecting"))
}

/// `cancelRun(db, entityId, runId)`.
pub(crate) async fn cancel_run(
    db: &PgPool,
    entity_id: &str,
    run_id: &str,
) -> Result<Value, RunError> {
    let run = load_run(db, entity_id, run_id).await?;
    assert_status(
        &run,
        &OPEN_RUN_STATUSES,
        "cancelled (void its payments instead)",
    )?;
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "update payment_runs t set status = 'cancelled', updated_at = $2::timestamp \
         where t.id = $1 and t.status in ('draft', 'pending_approval') returning ",
        weldsuite_books_domain::books_row!(payment_runs)
    ))
    .bind(s(&run, "id"))
    .bind(now())
    .fetch_optional(db)
    .await?;
    row.map(|row| PAYMENT_RUNS.js(row))
        .ok_or_else(|| changed_meanwhile("cancelling"))
}

/// `deleteRun(db, entityId, runId)`: a draft only.
pub(crate) async fn delete_run(
    db: &PgPool,
    entity_id: &str,
    run_id: &str,
) -> Result<Value, RunError> {
    let run = load_run(db, entity_id, run_id).await?;
    assert_status(&run, &["draft"], "deleted (cancel it instead)")?;
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "update payment_runs t set deleted_at = $2::timestamp, updated_at = $2::timestamp \
         where t.id = $1 and t.status = 'draft' returning ",
        weldsuite_books_domain::books_row!(payment_runs)
    ))
    .bind(s(&run, "id"))
    .bind(now())
    .fetch_optional(db)
    .await?;
    row.map(|row| PAYMENT_RUNS.js(row))
        .ok_or_else(|| changed_meanwhile("deleting"))
}

/// `releaseHold(db, args)`: the run and the vendor's holds after the release.
pub(crate) async fn release_hold(
    db: &PgPool,
    entity_id: &str,
    run_id: &str,
    party_id: &str,
    user_id: &str,
    reason: Option<&str>,
) -> Result<(Value, Vec<RunHold>), RunError> {
    let run = load_run(db, entity_id, run_id).await?;
    assert_status(
        &run,
        &OPEN_RUN_STATUSES,
        "changed: its payments are already made",
    )?;
    let before = decode_holds(run.get("holds"));
    let (refreshed, holds) = refresh_holds(db, &run, None).await?;
    let party_holds: Vec<&RunHold> = active_holds(&holds)
        .into_iter()
        .filter(|h| h.party_id == party_id)
        .collect();
    let had_holds = before
        .iter()
        .any(|h| h.party_id == party_id && !h.is_released());
    if party_holds.is_empty() {
        if !had_holds {
            return Err(run_error(
                "NOT_HELD",
                "This vendor has no hold on the run.".to_owned(),
                409,
                None,
            ));
        }
        return Ok((refreshed, Vec::new()));
    }
    if let Some(blocked) = party_holds.iter().find(|h| release_blocker(h).is_some()) {
        return Err(run_error(
            "HOLD_NOT_RELEASABLE",
            release_blocker(blocked).unwrap_or_default().to_owned(),
            409,
            Some(json!({ "code": blocked.code })),
        ));
    }
    let reason = reason
        .map(weldsuite_kit::validation::js_trim)
        .unwrap_or_default();
    if weldsuite_books_domain::js::utf16_len(reason) < 3 {
        return Err(bad(
            "REASON_REQUIRED",
            "Say why the hold is released (at least a few words); it is kept with the run.",
            None,
        ));
    }
    let mut release = Map::new();
    release.insert("by".to_owned(), json!(user_id));
    release.insert("at".to_owned(), json!(now()));
    release.insert(
        "reason".to_owned(),
        json!(weldsuite_books_domain::js::slice_utf16(reason, 500)),
    );
    let release = Value::Object(release);
    let next: Vec<RunHold> = holds
        .iter()
        .map(|h| {
            if h.party_id == party_id && !h.is_released() {
                RunHold {
                    released: release.clone(),
                    ..h.clone()
                }
            } else {
                h.clone()
            }
        })
        .collect();
    let totals = totals_of(&items_of(refreshed.get("items")), &next);
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "update payment_runs t set holds = $2, total_amount = $3::numeric, payment_count = $4, updated_at = $5::timestamp \
         where t.id = $1 and t.status in ('draft', 'pending_approval') returning ",
        weldsuite_books_domain::books_row!(payment_runs)
    ))
    .bind(s(&run, "id"))
    .bind(encode_holds(&next))
    .bind(&totals.total_amount)
    .bind(totals.payment_count)
    .bind(now())
    .fetch_optional(db)
    .await?;
    let Some(updated) = row.map(|row| PAYMENT_RUNS.js(row)) else {
        return Err(run_error(
            "INVALID_STATE",
            "The run changed while you were releasing the hold. Reload it and try again."
                .to_owned(),
            409,
            None,
        ));
    };
    let released = next
        .into_iter()
        .filter(|h| h.party_id == party_id)
        .collect();
    Ok((updated, released))
}

// ── Listing and detail ──────────────────────────────────────────────────────

fn encode_cursor(run: &Value) -> String {
    base64::engine::general_purpose::STANDARD.encode(format!(
        "{}|{}",
        s(run, "createdAt"),
        s(run, "id")
    ))
}

/// `decodeCursor(cursor)`: `atob`, then `iso|id`.
fn decode_cursor(cursor: &str) -> Option<(String, String)> {
    let cleaned: String = cursor
        .chars()
        .filter(|c| !c.is_ascii_whitespace())
        .collect();
    let trimmed = if cleaned.len().is_multiple_of(4) {
        cleaned.trim_end_matches('=').to_owned()
    } else {
        cleaned
    };
    let bytes = base64::engine::general_purpose::STANDARD_NO_PAD
        .decode(trimmed.as_bytes())
        .ok()?;
    // `atob` gives one character per byte.
    let decoded: String = bytes.iter().map(|b| char::from(*b)).collect();
    let mut parts = decoded.split('|');
    let iso = parts.next().unwrap_or_default();
    let id = parts.next().filter(|id| !id.is_empty())?;
    let millis = js_date_millis(iso)?;
    Some((
        weldsuite_books_domain::js::iso_from_millis(millis)?,
        id.to_owned(),
    ))
}

/// `pageLimit(raw, fallback, max)`.
pub(crate) fn page_limit(raw: Option<&str>, fallback: i64, max: i64) -> i64 {
    let raw = raw.filter(|r| !r.is_empty());
    let parsed = match raw {
        Some(raw) => parse_int(raw),
        None => Some(fallback),
    };
    parsed
        .filter(|n| *n != 0)
        .unwrap_or(fallback)
        .max(1)
        .min(max)
}

/// `summarize(run, bankAccountName)`.
pub(crate) fn summarize(run: &Value, bank_account_name: Value) -> Map<String, Value> {
    let holds = decode_holds(run.get("holds"));
    let held = held_party_ids(&holds);
    let field = |key: &str| run.get(key).cloned().unwrap_or(Value::Null);
    let mut out = Map::new();
    out.insert("id".to_owned(), field("id"));
    out.insert("bankAccountId".to_owned(), field("bankAccountId"));
    out.insert("bankAccountName".to_owned(), bank_account_name);
    for key in [
        "method",
        "status",
        "paymentDate",
        "secCode",
        "sameDay",
        "totalAmount",
        "paymentCount",
        "requiredApprovals",
    ] {
        out.insert(key.to_owned(), field(key));
    }
    out.insert("approvalCount".to_owned(), json!(approvals_of(run).len()));
    out.insert(
        "billCount".to_owned(),
        json!(items_of(run.get("items")).len()),
    );
    out.insert("heldVendorCount".to_owned(), json!(held.len()));
    for key in [
        "fileName",
        "fileGeneratedAt",
        "createdBy",
        "createdAt",
        "updatedAt",
        "notes",
    ] {
        out.insert(key.to_owned(), field(key));
    }
    out
}

/// `ListRunsFilter`.
pub(crate) struct ListRuns<'a> {
    pub status: Option<&'a str>,
    pub method: Option<&'a str>,
    pub bank_account_id: Option<&'a str>,
    pub limit: i64,
    pub cursor: Option<&'a str>,
}

macro_rules! runs_where {
    () => {
        "t.entity_id = $1 and t.deleted_at is null and ($2::text is null or t.status = $2) \
         and ($3::text is null or t.method = $3) and ($4::text is null or t.bank_account_id = $4)"
    };
}

/// `listRuns(db, entityId, filter)`: `(rows, totalCount, hasMore, cursor)`.
pub(crate) async fn list_runs(
    db: &PgPool,
    entity_id: &str,
    filter: ListRuns<'_>,
) -> Result<(Vec<Value>, i64, bool, Option<String>), RunError> {
    let after = match filter.cursor.filter(|c| !c.is_empty()) {
        Some(cursor) => Some(
            decode_cursor(cursor).ok_or_else(|| bad("INVALID_CURSOR", "Invalid cursor", None))?,
        ),
        None => None,
    };
    let (after_at, after_id) = after.unzip();
    let rows: Vec<(Value, Option<String>)> = sqlx::query_as(concat!(
        "select ",
        weldsuite_books_domain::books_row!(payment_runs),
        ", b.name from payment_runs t left join bank_accounts b on b.id = t.bank_account_id where ",
        runs_where!(),
        " and ($5::text is null or t.created_at < $5::timestamp or (t.created_at = $5::timestamp and t.id < $6)) \
         order by t.created_at desc, t.id desc limit $7"
    ))
    .bind(entity_id)
    .bind(filter.status)
    .bind(filter.method)
    .bind(filter.bank_account_id)
    .bind(after_at.as_deref())
    .bind(after_id.as_deref())
    .bind(filter.limit + 1)
    .fetch_all(db)
    .await?;
    let total: i64 = sqlx::query_scalar(concat!(
        "select count(*)::bigint from payment_runs t where ",
        runs_where!()
    ))
    .bind(entity_id)
    .bind(filter.status)
    .bind(filter.method)
    .bind(filter.bank_account_id)
    .fetch_one(db)
    .await?;
    let has_more = i64::try_from(rows.len()).unwrap_or(0) > filter.limit;
    let mut page: Vec<(Value, Option<String>)> = rows
        .into_iter()
        .map(|(row, name)| (PAYMENT_RUNS.js(row), name))
        .collect();
    if has_more {
        page.truncate(usize::try_from(filter.limit).unwrap_or(0));
    }
    let cursor = if has_more {
        page.last().map(|(run, _)| encode_cursor(run))
    } else {
        None
    };
    let rows = page
        .iter()
        .map(|(run, name)| Value::Object(summarize(run, json!(name))))
        .collect();
    Ok((rows, total, has_more, cursor))
}

fn money(value: f64) -> String {
    to_fixed(value, 2)
}

/// `getRunDetail(db, entityId, runId)`: the run with its bills, vendors,
/// holds, payments, approvals and history.
#[allow(clippy::too_many_lines)] // the view, field by field
pub(crate) async fn get_run_detail(
    db: &PgPool,
    entity_id: &str,
    run_id: &str,
) -> Result<Value, RunError> {
    let run = load_run(db, entity_id, run_id).await?;
    let items = items_of(run.get("items"));
    let holds = decode_holds(run.get("holds"));
    let bill_ids: Vec<String> = items.iter().map(|i| i.bill_id.clone()).collect();
    let party_ids = party_ids_of(&items);
    let bills: Vec<Value> = if bill_ids.is_empty() {
        Vec::new()
    } else {
        let rows: Vec<Value> = sqlx::query_scalar(concat!(
            "select ",
            weldsuite_books_domain::books_row!(bills),
            " from bills t where t.id = any($1)"
        ))
        .bind(&bill_ids)
        .fetch_all(db)
        .await?;
        BILLS.js_rows(rows)
    };
    let parties = load_parties(db, &party_ids).await?;
    let payments = run_payment_rows(db, s(&run, "id")).await?;
    let bank: Option<(String, String, Option<String>)> = sqlx::query_as(
        "select id, name, account_number_last4 from bank_accounts where id = $1 limit 1",
    )
    .bind(s(&run, "bankAccountId"))
    .fetch_optional(db)
    .await?;
    let history: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(audit_log),
        " from audit_log t where t.entity_type = 'payment_run' and t.entity_id = $1 order by t.timestamp"
    ))
    .bind(s(&run, "id"))
    .fetch_all(db)
    .await?;
    let history = AUDIT_LOG.js_rows(history);
    let name_of = |party_id: &str| -> String {
        parties
            .iter()
            .find(|p| s(p, "id") == party_id)
            .and_then(|p| text(p, "displayName"))
            .unwrap_or(party_id)
            .to_owned()
    };
    let open = OPEN_RUN_STATUSES.contains(&s(&run, "status"));
    let mut live_by_party: HashMap<String, &Value> = HashMap::new();
    for payment in &payments {
        if payment.get("deletedAt").is_none_or(Value::is_null) {
            live_by_party.insert(s(payment, "contactId").to_owned(), payment);
        }
    }
    let planned = if open {
        let unpaid: Vec<RunItem> = items
            .iter()
            .filter(|i| !live_by_party.contains_key(&i.party_id))
            .cloned()
            .collect();
        compute_run_withholding(
            db,
            entity_id,
            s(&run, "method") == "ach",
            s(&run, "paymentDate"),
            &unpaid,
            &parties,
        )
        .await?
    } else {
        Vec::new()
    };

    let mut vendors = Vec::new();
    let mut counted_gross = 0.0;
    let mut counted_withheld = 0.0;
    for party_id in &party_ids {
        let own: Vec<&RunItem> = items.iter().filter(|i| &i.party_id == party_id).collect();
        let party_holds: Vec<&RunHold> = holds.iter().filter(|h| &h.party_id == party_id).collect();
        let live = live_by_party.get(party_id).copied();
        let payment = live.or_else(|| payments.iter().find(|p| s(p, "contactId") == party_id));
        let gross = own.iter().fold(0.0, |sum, i| round_money(sum + i.amount));
        let held = party_holds.iter().any(|h| !h.is_released());
        let preview = planned
            .iter()
            .find(|(id, _)| id == party_id)
            .map(|(_, w)| *w);
        let withheld = match live {
            Some(live) => parse_float(text(live, "backupWithholdingAmount").unwrap_or("0")),
            None => preview.map_or(0.0, |p| p.amount),
        };
        if live.is_some() || (open && !held) {
            counted_gross =
                round_money(counted_gross + live.map_or(gross, |l| parse_float(s(l, "amount"))));
            counted_withheld = round_money(counted_withheld + withheld);
        }
        let backup = if withheld > 0.0 {
            json!({
                "amount": money(withheld),
                "net": money(live.map_or_else(|| round_money(gross - withheld), payment_net_amount)),
                "reason": preview.and_then(|p| p.reason),
                "rate": preview.map_or(BACKUP_WITHHOLDING_RATE, |p| p.rate),
            })
        } else {
            Value::Null
        };
        vendors.push(json!({
            "partyId": party_id,
            "name": name_of(party_id),
            "amount": money(gross),
            "billCount": own.len(),
            "held": held,
            "backupWithholding": backup,
            "holds": party_holds.iter().map(|h| json!({
                "code": h.code,
                "message": h.message,
                "releasable": release_blocker(h).is_none(),
                "released": h.released,
                "blocker": release_blocker(h),
            })).collect::<Vec<_>>(),
            "payment": payment.map(payment_view),
        }));
    }

    let mut out = summarize(
        &run,
        bank.as_ref()
            .map_or(Value::Null, |(_, name, _)| json!(name)),
    );
    out.insert(
        "bankAccount".to_owned(),
        bank.as_ref().map_or(
            Value::Null,
            |(id, name, last4)| json!({ "id": id, "name": name, "accountNumberLast4": last4 }),
        ),
    );
    let totals = totals_of(&items, &holds);
    out.insert("totalAmount".to_owned(), json!(totals.total_amount));
    out.insert("heldAmount".to_owned(), json!(totals.held_amount));
    out.insert("paymentCount".to_owned(), json!(totals.payment_count));
    out.insert("withheldAmount".to_owned(), json!(money(counted_withheld)));
    out.insert(
        "netAmount".to_owned(),
        json!(money(round_money(counted_gross - counted_withheld))),
    );
    out.insert("approvals".to_owned(), Value::Array(approvals_of(&run)));
    out.insert(
        "items".to_owned(),
        Value::Array(
            items
                .iter()
                .map(|i| {
                    let bill = bills.iter().find(|b| s(b, "id") == i.bill_id);
                    let of = |key: &str| {
                        bill.and_then(|b| b.get(key))
                            .cloned()
                            .unwrap_or(Value::Null)
                    };
                    json!({
                        "billId": i.bill_id,
                        "billNumber": of("billNumber"),
                        "partyId": i.party_id,
                        "partyName": name_of(&i.party_id),
                        "amount": money(i.amount),
                        "billTotal": of("total"),
                        "balanceDue": of("balanceDue"),
                        "dueDate": of("dueDate"),
                    })
                })
                .collect(),
        ),
    );
    out.insert("vendors".to_owned(), Value::Array(vendors));
    out.insert(
        "holds".to_owned(),
        Value::Array(
            holds
                .iter()
                .map(|h| {
                    json!({
                        "partyId": h.party_id,
                        "partyName": name_of(&h.party_id),
                        "code": h.code,
                        "message": h.message,
                        "released": h.released,
                        "releasable": release_blocker(h).is_none(),
                    })
                })
                .collect(),
        ),
    );
    out.insert(
        "history".to_owned(),
        Value::Array(
            history
                .iter()
                .map(|h| {
                    let of = |key: &str| h.get(key).cloned().unwrap_or(Value::Null);
                    json!({ "action": of("action"), "userId": of("userId"), "at": of("timestamp"), "changes": of("changes") })
                })
                .collect(),
        ),
    );
    Ok(Value::Object(out))
}

/// The payments of a run (voided ones too), as the database returns them.
pub(crate) async fn run_payment_rows(db: &PgPool, run_id: &str) -> Result<Vec<Value>, sqlx::Error> {
    let rows: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(payments),
        " from payments t where t.payment_run_id = $1"
    ))
    .bind(run_id)
    .fetch_all(db)
    .await?;
    Ok(PAYMENTS.js_rows(rows))
}

/// A vendor's payment in the run view.
fn payment_view(payment: &Value) -> Value {
    let deleted = payment.get("deletedAt").is_some_and(|d| !d.is_null());
    let withheld = payment
        .get("backupWithholdingAmount")
        .cloned()
        .unwrap_or(Value::Null);
    let has_withholding = parse_float(withheld.as_str().unwrap_or("0")) > 0.0;
    json!({
        "id": payment.get("id"),
        "amount": payment.get("amount"),
        "backupWithholdingAmount": if has_withholding { withheld } else { Value::Null },
        "netAmount": money(payment_net_amount(payment)),
        "checkNumber": payment.get("checkNumber"),
        "checkStatus": if deleted { json!("voided") } else { payment.get("checkStatus").cloned().unwrap_or(Value::Null) },
        "deleted": deleted,
    })
}

// ── Bills that can go into a run ────────────────────────────────────────────

/// `listPayableBills(db, filter)`: approved bills with an open balance, by
/// vendor, with each vendor's ACH readiness.
#[allow(clippy::too_many_lines)] // the view, field by field
pub(crate) async fn list_payable_bills(
    db: &PgPool,
    entity_id: &str,
    due_before: Option<&str>,
    party_id: Option<&str>,
    bank_account_id: Option<&str>,
) -> Result<Vec<Value>, RunError> {
    let now = now_ms();
    let rows: Vec<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(bills),
        " from bills t where t.entity_id = $1 and t.deleted_at is null and t.type = 'standard' \
         and t.status in ('approved', 'partial', 'overdue') and coalesce(t.balance_due, '0')::numeric > 0 \
         and ($2::text is null or t.contact_id = $2) \
         and ($3::text is null or t.due_date < ($3::date + interval '1 day')) \
         order by t.due_date, t.id"
    ))
    .bind(entity_id)
    .bind(party_id)
    .bind(due_before)
    .fetch_all(db)
    .await?;
    let bills = BILLS.js_rows(rows);
    if bills.is_empty() {
        return Ok(Vec::new());
    }
    let mut party_ids: Vec<String> = Vec::new();
    for bill in &bills {
        let id = s(bill, "contactId").to_owned();
        if !party_ids.contains(&id) {
            party_ids.push(id);
        }
    }
    let parties = load_parties(db, &party_ids).await?;
    let open_runs: Vec<(String, Option<Value>)> = sqlx::query_as(
        "select id, items from payment_runs where entity_id = $1 and deleted_at is null \
         and status in ('draft', 'pending_approval')",
    )
    .bind(entity_id)
    .fetch_all(db)
    .await?;
    let history = load_ach_history(db, entity_id, &party_ids).await?;
    let bank = match bank_account_id {
        Some(id) => Some(load_bank_account(db, entity_id, id).await?),
        None => None,
    };
    let hold_window_days = bank.as_ref().map_or(DEFAULT_HOLD_WINDOW_DAYS, |b| {
        read_ach_settings(b.get("achSettings")).hold_window_days
    });
    let mut bill_run: HashMap<String, String> = HashMap::new();
    for (run_id, items) in &open_runs {
        for item in items_of(items.as_ref()) {
            bill_run.insert(item.bill_id, run_id.clone());
        }
    }
    let today: String = weldsuite_books_domain::js::iso_from_millis(now)
        .unwrap_or_default()
        .chars()
        .take(10)
        .collect();

    let mut vendors: Vec<(String, Value)> = Vec::new();
    for party_id in &party_ids {
        let party = parties.iter().find(|p| s(p, "id") == party_id);
        let own: Vec<&Value> = bills
            .iter()
            .filter(|b| s(b, "contactId") == party_id)
            .collect();
        let total_due = own.iter().fold(0.0, |sum, b| {
            round_money(sum + parse_float(text(b, "balanceDue").unwrap_or("0")))
        });
        let ach = party.map(|p| vendor_ach_status(p, hold_window_days, now));
        let withholding = match party {
            Some(p) if weldsuite_books_domain::js::truthy(p.get("is1099Vendor")) => Some(
                compute_backup_withholding(
                    db,
                    ComputeBackupWithholdingInput {
                        entity_id,
                        party_id,
                        gross_amount: total_due,
                        day: &today,
                        ..ComputeBackupWithholdingInput::default()
                    },
                )
                .await?,
            ),
            _ => None,
        };
        let name = party
            .and_then(|p| text(p, "displayName"))
            .or_else(|| own.first().and_then(|b| text(b, "contactName")))
            .unwrap_or(party_id)
            .to_owned();
        let address_lines = party.map_or_else(Vec::new, |p| {
            let address = p
                .get("billingAddress")
                .filter(|a| weldsuite_books_domain::js::truthy(Some(a)))
                .map(|a| {
                    let mut merged = Map::new();
                    merged.insert("country".to_owned(), json!("US"));
                    if let Some(fields) = a.as_object() {
                        for (key, value) in fields {
                            merged.insert(key.clone(), value.clone());
                        }
                    }
                    Value::Object(merged)
                });
            format_postal_address_lines(address.as_ref(), Some("US"))
        });
        let ach_view = match (ach, party) {
            (Some(ach), Some(p)) => {
                let empty = AchHistory::default();
                let mut view = ach.to_json();
                view.insert(
                    "prenote".to_owned(),
                    json!(prenote_state(
                        p,
                        history.get(party_id).unwrap_or(&empty),
                        now
                    )),
                );
                view.insert("held".to_owned(), json!(ach.hold_active));
                Value::Object(view)
            }
            _ => Value::Null,
        };
        let backup = match withholding {
            Some(w) if w.amount > 0.0 => json!({
                "applies": true,
                "reason": w.reason,
                "rate": w.rate,
                "amount": money(w.amount),
                "net": money(w.net),
            }),
            _ => json!({ "applies": false }),
        };
        let bill_views: Vec<Value> = own
            .iter()
            .map(|b| {
                let of = |key: &str| b.get(key).cloned().unwrap_or(Value::Null);
                let due = text(b, "dueDate").and_then(millis_of).unwrap_or(now);
                let reference = match b.get("reference") {
                    Some(Value::Null) | None => of("externalReference"),
                    Some(value) => value.clone(),
                };
                json!({
                    "id": of("id"),
                    "billNumber": of("billNumber"),
                    "reference": reference,
                    "status": of("status"),
                    "issueDate": of("issueDate"),
                    "dueDate": of("dueDate"),
                    "daysOverdue": (now - due).div_euclid(86_400_000).max(0),
                    "currency": of("currency"),
                    "total": of("total"),
                    "balanceDue": of("balanceDue"),
                    "inOpenRunId": bill_run.get(s(b, "id")),
                })
            })
            .collect();
        vendors.push((
            name.clone(),
            json!({
                "partyId": party_id,
                "name": name,
                "addressLines": address_lines,
                "totalDue": money(total_due),
                "ach": ach_view,
                "backupWithholding": backup,
                "bills": bill_views,
            }),
        ));
    }
    vendors.sort_by(|a, b| locale_compare(&a.0, &b.0));
    Ok(vendors.into_iter().map(|(_, v)| v).collect())
}
