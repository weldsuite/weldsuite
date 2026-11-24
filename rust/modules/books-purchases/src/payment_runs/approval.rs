//! Approving a payment run and making its payments
//! (`services/payment-runs/approval.ts` and `payments.ts`).
//!
//! Approvals are distinct users with `banking:manage`; a run needs
//! `requiredApprovals` of them, and its creator never counts as the only one
//! of two. Holds are evaluated again at every approval. Only the last
//! approval makes the payments: one per vendor that isn't held, allocated
//! over its bills, posted, linked to the run, numbered for a check run, with
//! any backup withholding. Each payment's id derives from the run and the
//! vendor, so approving again after a failure midway never pays twice.

use sea_orm::prelude::BigDecimal;
use sea_orm::sea_query::{Expr, Func};
use sea_orm::{ColumnTrait, Condition, DbErr, EntityTrait, QueryFilter, QueryOrder, QuerySelect};
use serde_json::{Value, json};
use weldsuite_books_domain::guards::{PostingCheck, PostingLockKind, assert_posting_allowed};
use weldsuite_books_domain::http::now;
use weldsuite_books_domain::js::{locale_compare, parse_float, round_money, to_fixed};
use weldsuite_books_domain::payments::{
    AllocationInput, RecordPaymentInput, payment_net_amount, record_payment,
};
use weldsuite_books_domain::posting::PostError;
use weldsuite_books_domain::vendor_tax::sha256_hex;
use weldsuite_db::{PgPool, orm, utc_now};
use weldsuite_ports::OutboundHttp;
use weldsuite_schema::tenant::{bank_accounts, payment_runs, payments};

use super::holds::{RunHold, active_holds, encode_holds, held_party_ids, load_parties};
use super::runs::{
    RunItem, approvals_of, assert_status, compute_run_withholding, items_of, load_run,
    refresh_holds, required_approvals, resolve_items, s, text, totals_of,
};
use super::{Faults, RunError, load_bank_account, run_error};
use crate::rows::{decimal_of, int4, js, js_rows, money_text};

/// `runReference(runId)`: the marker on the reference of a run's payments.
pub(crate) fn run_reference(run_id: &str) -> String {
    format!("Payment run {run_id}")
}

/// `runPaymentId(runId, partyId, attempt)`: `pay_` and 24 hex digits of a
/// SHA-256 over the run and the vendor.
pub(crate) fn run_payment_id(run_id: &str, party_id: &str, attempt: usize) -> String {
    let suffix = if attempt > 0 {
        format!(":{attempt}")
    } else {
        String::new()
    };
    let hex = sha256_hex(&format!("payment-run:{run_id}:{party_id}{suffix}"));
    format!("pay_{}", &hex[..24])
}

const MAX_CLAIM_ATTEMPTS: usize = 100;

fn check_number_required() -> RunError {
    run_error(
        "CHECK_NUMBER_REQUIRED",
        "Set the next check number in the bank account's check settings.".to_owned(),
        409,
        None,
    )
}

/// `claimCheckNumber(db, bankAccountId)`: an atomic bump of the counter
/// (one `update … returning`), skipping any number a payment (voided ones
/// included) holds.
async fn claim_check_number(db: &PgPool, bank_account_id: &str) -> Result<String, RunError> {
    use sea_orm::ExprTrait as _;
    let db = orm(db);
    for _ in 0..MAX_CLAIM_ATTEMPTS {
        let bumped = Expr::from(Func::coalesce([
            Expr::col(bank_accounts::Column::NextCheckNumber),
            Expr::val(1),
        ]))
        .add(1);
        let next = bank_accounts::Entity::update_many()
            .col_expr(bank_accounts::Column::NextCheckNumber, bumped)
            .col_expr(bank_accounts::Column::UpdatedAt, Expr::value(utc_now()))
            .filter(bank_accounts::Column::Id.eq(bank_account_id))
            .exec_with_returning(&db)
            .await?
            .into_iter()
            .next()
            .and_then(|bank| bank.next_check_number);
        let Some(next) = next else {
            return Err(check_number_required());
        };
        let claimed = (i64::from(next) - 1).to_string();
        let taken: Option<String> = payments::Entity::find()
            .select_only()
            .column(payments::Column::Id)
            .filter(payments::Column::BankAccountId.eq(bank_account_id))
            .filter(payments::Column::CheckNumber.eq(claimed.as_str()))
            .into_tuple()
            .one(&db)
            .await?;
        if taken.is_none() {
            return Ok(claimed);
        }
    }
    Err(run_error(
        "CHECK_NUMBER_EXHAUSTED",
        "The next check numbers are all in use already. Set a higher next check number in the bank account's check settings.".to_owned(),
        409,
        None,
    ))
}

async fn read_check_number(db: &PgPool, payment_id: &str) -> Result<Option<String>, DbErr> {
    let row: Option<Option<String>> = payments::Entity::find()
        .select_only()
        .column(payments::Column::CheckNumber)
        .filter(payments::Column::Id.eq(payment_id))
        .into_tuple()
        .one(&orm(db))
        .await?;
    Ok(row.flatten())
}

/// `numberCheck(db, paymentId, bankAccountId)`: a check keeps the number it has.
async fn number_check(
    db: &PgPool,
    payment_id: &str,
    bank_account_id: &str,
) -> Result<String, RunError> {
    if let Some(current) = read_check_number(db, payment_id)
        .await?
        .filter(|n| !n.is_empty())
    {
        return Ok(current);
    }
    let claimed = claim_check_number(db, bank_account_id).await?;
    let updated = payments::Entity::update_many()
        .col_expr(payments::Column::CheckNumber, Expr::value(claimed.as_str()))
        .col_expr(payments::Column::UpdatedAt, Expr::value(utc_now()))
        .filter(payments::Column::Id.eq(payment_id))
        .filter(payments::Column::CheckNumber.is_null())
        .exec_with_returning(&orm(db))
        .await?
        .into_iter()
        .next()
        .and_then(|payment| payment.check_number);
    if let Some(number) = updated {
        return Ok(number);
    }
    // Someone numbered it in between: theirs stands.
    Ok(read_check_number(db, payment_id).await?.unwrap_or(claimed))
}

/// `RunPaymentArgs`.
pub(crate) struct RunPayment<'a> {
    pub entity_id: &'a str,
    pub run_id: Option<&'a str>,
    pub id: Option<String>,
    pub check: bool,
    pub bank_account_id: &'a str,
    pub party_id: &'a str,
    /// `YYYY-MM-DD`.
    pub date: &'a str,
    pub allocations: Vec<(String, f64)>,
    pub backup_withholding_amount: f64,
    pub user_id: &'a str,
    pub notes: Option<String>,
    pub reference: Option<String>,
}

/// `RunPaymentResult`.
#[derive(Debug, Clone)]
pub(crate) struct RunPaymentResult {
    pub payment_id: String,
    pub check_number: Option<String>,
    pub amount: f64,
    pub backup_withholding_amount: f64,
    pub net_amount: f64,
}

/// `createRunPayment(db, args)`: one vendor's payment, posted, linked to the
/// run and (for checks) numbered.
pub(crate) async fn create_run_payment(
    db: &PgPool,
    http: Option<&OutboundHttp>,
    faults: &Faults,
    args: RunPayment<'_>,
) -> Result<RunPaymentResult, RunError> {
    let amount = args
        .allocations
        .iter()
        .fold(0.0, |sum, (_, a)| round_money(sum + a));
    let withheld = round_money(args.backup_withholding_amount);
    faults.record_payment()?;
    let result = record_payment(
        db,
        http,
        RecordPaymentInput {
            id: args.id.clone(),
            entity_id: args.entity_id.to_owned(),
            received: false,
            amount,
            date: format!("{}T00:00:00.000Z", args.date),
            payment_method: Some(if args.check { "check" } else { "ach" }.to_owned()),
            check_status: args.check.then(|| "to_print".to_owned()),
            reference: args
                .reference
                .clone()
                .or_else(|| args.run_id.map(run_reference)),
            notes: args.notes.clone(),
            contact_id: Some(args.party_id.to_owned()),
            bank_account_id: Some(args.bank_account_id.to_owned()),
            payment_run_id: args.run_id.map(str::to_owned),
            backup_withholding_amount: (withheld > 0.0).then_some(withheld),
            allocations: args
                .allocations
                .iter()
                .map(|(bill_id, amount)| AllocationInput {
                    bill_id: Some(bill_id.clone()),
                    amount: *amount,
                    ..AllocationInput::default()
                })
                .collect(),
            user_id: Some(args.user_id.to_owned()),
            ..RecordPaymentInput::default()
        },
    )
    .await?;
    let check_number = if args.check {
        Some(number_check(db, &result.payment_id, args.bank_account_id).await?)
    } else {
        None
    };
    // A payment that already existed (same id) is returned as it was stored.
    let stored: Option<(BigDecimal, Option<BigDecimal>)> = payments::Entity::find()
        .select_only()
        .columns([
            payments::Column::Amount,
            payments::Column::BackupWithholdingAmount,
        ])
        .filter(payments::Column::Id.eq(result.payment_id.as_str()))
        .into_tuple()
        .one(&orm(db))
        .await?;
    // `amount::text`, `backup_withholding_amount::text`.
    let stored =
        stored.map(|(amount, withheld)| (money_text(&amount), withheld.as_ref().map(money_text)));
    let (amount, backup, net) = match stored {
        Some((stored_amount, stored_withheld)) => {
            let row =
                json!({ "amount": stored_amount, "backupWithholdingAmount": stored_withheld });
            (
                round_money(parse_float(&stored_amount)),
                round_money(parse_float(stored_withheld.as_deref().unwrap_or("0"))),
                payment_net_amount(&row),
            )
        }
        None => (amount, withheld, round_money(amount - withheld)),
    };
    Ok(RunPaymentResult {
        payment_id: result.payment_id,
        check_number,
        amount,
        backup_withholding_amount: backup,
        net_amount: net,
    })
}

/// `numberUnnumberedChecks(db, runId, bankAccountId)`.
async fn number_unnumbered_checks(
    db: &PgPool,
    run_id: &str,
    bank_account_id: &str,
) -> Result<(), RunError> {
    let ids: Vec<String> = payments::Entity::find()
        .select_only()
        .column(payments::Column::Id)
        .filter(payments::Column::PaymentRunId.eq(run_id))
        .filter(payments::Column::CheckNumber.is_null())
        .filter(payments::Column::DeletedAt.is_null())
        .order_by_asc(payments::Column::CreatedAt)
        .order_by_asc(payments::Column::Id)
        .into_tuple()
        .all(&orm(db))
        .await?;
    for id in ids {
        number_check(db, &id, bank_account_id).await?;
    }
    Ok(())
}

/// `findRunPayments(db, run, opts)`.
async fn find_run_payments(
    db: &PgPool,
    run: &Value,
    party_ids: Option<&[String]>,
    include_deleted: bool,
) -> Result<Vec<Value>, DbErr> {
    let mut found = Condition::all()
        .add(payments::Column::EntityId.eq(s(run, "entityId")))
        .add(payments::Column::Type.eq("sent"))
        .add(payments::Column::PaymentRunId.eq(s(run, "id")));
    if !include_deleted {
        found = found.add(payments::Column::DeletedAt.is_null());
    }
    if let Some(party_ids) = party_ids {
        found = found.add(payments::Column::ContactId.is_in(party_ids));
    }
    let rows = payments::Entity::find().filter(found).all(&orm(db)).await?;
    js_rows!(rows)
}

/// `RunPaymentView`.
#[allow(clippy::too_many_arguments, clippy::needless_pass_by_value)] // the view's fields
pub(crate) fn payment_view(
    payment_id: &str,
    party_id: &str,
    party_name: &str,
    amount: Value,
    backup: Value,
    net: f64,
    check_number: Option<String>,
    created: bool,
) -> Value {
    json!({
        "paymentId": payment_id,
        "partyId": party_id,
        "partyName": party_name,
        "amount": amount,
        "backupWithholdingAmount": backup,
        "netAmount": to_fixed(net, 2),
        "checkNumber": check_number,
        "created": created,
    })
}

/// `ApproveResult`.
pub(crate) struct ApproveResult {
    pub run: Value,
    pub approval_count: usize,
    pub approved: bool,
    pub payments: Vec<Value>,
}

/// `payDate(run)` as the guards and the payments read it.
fn pay_date(run: &Value) -> String {
    format!("{}T00:00:00.000Z", s(run, "paymentDate"))
}

/// `preflight(db, run, userId)`: everything checked before the first
/// payment, so a run fails whole or not at all.
async fn preflight(
    db: &PgPool,
    run: &Value,
    user_id: &str,
) -> Result<(Value, Value, Vec<RunHold>, Vec<RunItem>), RunError> {
    let entity_id = s(run, "entityId");
    let bank = load_bank_account(db, entity_id, s(run, "bankAccountId")).await?;
    let (refreshed, holds) = refresh_holds(db, run, Some(&bank)).await?;
    let held = held_party_ids(&holds);
    // Vendors an interrupted attempt already paid stay in the run, held or not.
    let already_paid: Vec<String> = find_run_payments(db, run, None, false)
        .await?
        .iter()
        .map(|p| s(p, "contactId").to_owned())
        .collect();
    let payable: Vec<RunItem> = items_of(refreshed.get("items"))
        .into_iter()
        .filter(|i| !held.contains(&i.party_id) || already_paid.contains(&i.party_id))
        .collect();
    let unpaid: Vec<&RunItem> = payable
        .iter()
        .filter(|i| !already_paid.contains(&i.party_id))
        .collect();
    let ach = s(run, "method") == "ach";
    let prenotes = ach
        && holds
            .iter()
            .any(|h| h.code == "prenote_required" && !h.is_released());
    if payable.is_empty() && !prenotes {
        return Err(run_error(
            "NOTHING_TO_PAY",
            "Every vendor in this run is on hold. Release the holds, or fix the vendors, before approving.".to_owned(),
            409,
            Some(json!({
                "holds": active_holds(&holds)
                    .iter()
                    .map(|h| json!({ "partyId": h.party_id, "code": h.code }))
                    .collect::<Vec<_>>(),
            })),
        ));
    }
    if !unpaid.is_empty() {
        let input: Vec<(String, f64)> = unpaid
            .iter()
            .map(|i| (i.bill_id.clone(), i.amount))
            .collect();
        if let Err(error) = resolve_items(db, entity_id, &input).await {
            return Err(match error {
                RunError::Run(problem) if problem.status == 400 => {
                    let mut details = serde_json::Map::new();
                    details.insert("cause".to_owned(), json!(problem.code));
                    if let Some(Value::Object(extra)) = &problem.details {
                        for (key, value) in extra {
                            details.insert(key.clone(), value.clone());
                        }
                    }
                    run_error(
                        "BILLS_CHANGED",
                        format!(
                            "A bill in this run changed since it was planned: {} Reject the run, adjust it and submit it again.",
                            problem.message
                        ),
                        409,
                        Some(Value::Object(details)),
                    )
                }
                other => other,
            });
        }
        let date = pay_date(run);
        assert_posting_allowed(
            db,
            PostingCheck {
                entity_id,
                date: &date,
                kind: PostingLockKind::General,
                affects_tax: false,
                user_id: Some(user_id),
            },
        )
        .await?;
    }
    if !ach && !unpaid.is_empty() && bank.get("nextCheckNumber").is_none_or(Value::is_null) {
        return Err(check_number_required());
    }
    Ok((refreshed, bank, holds, payable))
}

/// `hasIndependentApprover(run, approvers)`.
fn has_independent_approver(run: &Value, approvers: &[String]) -> bool {
    if required_approvals(run) < 2 {
        return true;
    }
    let creator = text(run, "createdBy");
    approvers.iter().any(|id| Some(id.as_str()) != creator)
}

/// `approveRun(db, { entityId, runId, userId })`: one approval; the last one
/// makes the payments.
#[allow(clippy::too_many_lines)] // the worker's steps, in its order
pub(crate) async fn approve_run(
    db: &PgPool,
    http: Option<&OutboundHttp>,
    faults: &Faults,
    entity_id: &str,
    run_id: &str,
    user_id: &str,
) -> Result<ApproveResult, RunError> {
    let loaded = load_run(db, entity_id, run_id).await?;
    assert_status(&loaded, &["pending_approval"], "approved")?;
    let (run, bank, holds, payable) = preflight(db, &loaded, user_id).await?;
    let approvals = approvals_of(&run);
    let required = usize::try_from(required_approvals(&run)).unwrap_or(0);
    let already_complete = approvals.len() >= required;
    let mut current = approvals.clone();
    if !already_complete {
        if approvals
            .iter()
            .any(|a| a.get("userId").and_then(Value::as_str) == Some(user_id))
        {
            return Err(run_error(
                "ALREADY_APPROVED",
                if required > 1 {
                    "You already approved this run. A second approver has to be someone else."
                } else {
                    "You already approved this run."
                }
                .to_owned(),
                409,
                None,
            ));
        }
        current.push(json!({ "userId": user_id, "at": now() }));
        let approvers: Vec<String> = current
            .iter()
            .map(|a| {
                a.get("userId")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned()
            })
            .collect();
        if current.len() >= required && !has_independent_approver(&run, &approvers) {
            return Err(run_error(
                "NEEDS_SECOND_APPROVER",
                "The person who made this run can't be its only approver.".to_owned(),
                409,
                None,
            ));
        }
        // Compare-and-set on the approvals so two approvers arriving together can't both finish the run.
        let unchanged = if approvals.is_empty() {
            Condition::any()
                .add(payment_runs::Column::Approvals.is_null())
                .add(payment_runs::Column::Approvals.eq(json!([])))
        } else {
            Condition::all()
                .add(payment_runs::Column::Approvals.eq(Value::Array(approvals.clone())))
        };
        let recorded = payment_runs::Entity::update_many()
            .col_expr(
                payment_runs::Column::Approvals,
                Expr::value(Value::Array(current.clone())),
            )
            .col_expr(payment_runs::Column::UpdatedAt, Expr::value(utc_now()))
            .filter(payment_runs::Column::Id.eq(s(&run, "id")))
            .filter(payment_runs::Column::Status.eq("pending_approval"))
            .filter(unchanged)
            .exec(&orm(db))
            .await?;
        if recorded.rows_affected == 0 {
            return Err(run_error(
                "CONFLICT",
                "Someone else just approved this run. Reload it to see where it stands.".to_owned(),
                409,
                None,
            ));
        }
    }

    if current.len() < required {
        let updated = super::runs::find_run(db, s(&run, "id")).await?;
        return Ok(ApproveResult {
            run: updated.unwrap_or(run),
            approval_count: current.len(),
            approved: false,
            payments: Vec::new(),
        });
    }

    let payments = make_payments(db, http, faults, &run, &bank, &payable, user_id).await?;
    let totals = totals_of(&items_of(run.get("items")), &holds);
    let total = payments.iter().fold(0.0, |sum, p| {
        weldsuite_books_domain::js::math_round(
            (sum + weldsuite_books_domain::js::numeric(&p["amount"])) * 100.0,
        ) / 100.0
    });
    let count = if payments.is_empty() {
        totals.payment_count
    } else {
        i64::try_from(payments.len()).unwrap_or(0)
    };
    let row = payment_runs::Entity::update_many()
        .col_expr(payment_runs::Column::Status, Expr::value("approved"))
        .col_expr(
            payment_runs::Column::Approvals,
            Expr::value(Value::Array(current.clone())),
        )
        .col_expr(
            payment_runs::Column::Holds,
            Expr::value(encode_holds(&holds)),
        )
        .col_expr(
            payment_runs::Column::TotalAmount,
            Expr::value(decimal_of(&to_fixed(total, 2))?),
        )
        .col_expr(
            payment_runs::Column::PaymentCount,
            Expr::value(int4(count)?),
        )
        .col_expr(payment_runs::Column::UpdatedAt, Expr::value(utc_now()))
        .filter(payment_runs::Column::Id.eq(s(&run, "id")))
        .filter(payment_runs::Column::Status.eq("pending_approval"))
        .exec_with_returning(&orm(db))
        .await?
        .into_iter()
        .next();
    let run = match row {
        Some(row) => js!(row)?,
        None => run,
    };
    Ok(ApproveResult {
        run,
        approval_count: current.len(),
        approved: true,
        payments,
    })
}

/// `makePayments(db, run, bank, payable, userId)`: one payment per vendor
/// that isn't held. Safe to call again after a failure.
#[allow(clippy::too_many_arguments)]
#[allow(clippy::too_many_lines)] // the worker's steps, in its order
async fn make_payments(
    db: &PgPool,
    http: Option<&OutboundHttp>,
    faults: &Faults,
    run: &Value,
    bank: &Value,
    payable: &[RunItem],
    user_id: &str,
) -> Result<Vec<Value>, RunError> {
    let check = s(run, "method") == "check";
    let mut party_ids = super::holds::party_ids_of(payable);
    if party_ids.is_empty() {
        return Ok(Vec::new());
    }
    let parties = load_parties(db, &party_ids).await?;
    let name_of = |id: &str| -> String {
        parties
            .iter()
            .find(|p| s(p, "id") == id)
            .map_or(id, |p| text(p, "displayName").unwrap_or_else(|| s(p, "id")))
            .to_owned()
    };
    party_ids.sort_by(|a, b| {
        locale_compare(&name_of(a), &name_of(b)).then_with(|| locale_compare(a, b))
    });

    // What the run already paid these vendors (an earlier, interrupted attempt), voided payments included.
    let existing = find_run_payments(db, run, Some(&party_ids), true).await?;
    let deleted = |p: &Value| p.get("deletedAt").is_some_and(|d| !d.is_null());
    let mut live_by_party: Vec<(String, &Value)> = Vec::new();
    for payment in existing.iter().filter(|p| !deleted(p)) {
        let contact = s(payment, "contactId").to_owned();
        live_by_party.retain(|(id, _)| id != &contact);
        live_by_party.push((contact, payment));
    }
    let live = |party_id: &str| {
        live_by_party
            .iter()
            .find(|(id, _)| id == party_id)
            .map(|(_, p)| *p)
    };
    let unpaid: Vec<RunItem> = payable
        .iter()
        .filter(|i| live(&i.party_id).is_none())
        .cloned()
        .collect();
    let date = s(run, "paymentDate").to_owned();
    let withholding =
        compute_run_withholding(db, s(run, "entityId"), !check, &date, &unpaid, &parties).await?;

    let bank_id = s(bank, "id");
    let mut views: Vec<Value> = Vec::new();
    for party_id in &party_ids {
        if let Some(found) = live(party_id) {
            views.push(payment_view(
                s(found, "id"),
                party_id,
                &name_of(party_id),
                found.get("amount").cloned().unwrap_or(Value::Null),
                found
                    .get("backupWithholdingAmount")
                    .cloned()
                    .unwrap_or(Value::Null),
                payment_net_amount(found),
                text(found, "checkNumber").map(str::to_owned),
                false,
            ));
            continue;
        }
        let voided = existing
            .iter()
            .filter(|p| s(p, "contactId") == party_id && deleted(p))
            .count();
        let created = create_run_payment(
            db,
            http,
            faults,
            RunPayment {
                entity_id: s(run, "entityId"),
                run_id: Some(s(run, "id")),
                // The same vendor in the same run is the same payment: approving again can't pay it twice.
                id: Some(run_payment_id(s(run, "id"), party_id, voided)),
                check,
                bank_account_id: bank_id,
                party_id,
                date: &date,
                allocations: payable
                    .iter()
                    .filter(|i| &i.party_id == party_id)
                    .map(|i| (i.bill_id.clone(), i.amount))
                    .collect(),
                backup_withholding_amount: withholding
                    .iter()
                    .find(|(id, _)| id == party_id)
                    .map_or(0.0, |(_, w)| w.amount),
                user_id,
                notes: None,
                reference: None,
            },
        )
        .await?;
        views.push(payment_view(
            &created.payment_id,
            party_id,
            &name_of(party_id),
            json!(to_fixed(created.amount, 2)),
            if created.backup_withholding_amount > 0.0 {
                json!(to_fixed(created.backup_withholding_amount, 2))
            } else {
                Value::Null
            },
            created.net_amount,
            created.check_number,
            true,
        ));
    }

    if check {
        number_unnumbered_checks(db, s(run, "id"), bank_id).await?;
        let ids: Vec<String> = views.iter().map(|v| s(v, "paymentId").to_owned()).collect();
        let numbered: Vec<(String, Option<String>)> = payments::Entity::find()
            .select_only()
            .columns([payments::Column::Id, payments::Column::CheckNumber])
            .filter(payments::Column::Id.is_in(&ids))
            .into_tuple()
            .all(&orm(db))
            .await?;
        for view in &mut views {
            let id = s(view, "paymentId").to_owned();
            if let Some((_, Some(number))) = numbered.iter().find(|(pid, _)| *pid == id) {
                view["checkNumber"] = json!(number);
            }
        }
    }
    Ok(views)
}

impl From<PostError> for RunError {
    fn from(error: PostError) -> Self {
        match error.user_message() {
            Some(message) => RunError::BadRequest(message),
            None => RunError::Internal(error.to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn payment_ids_derive_from_the_run_and_the_vendor() {
        let first = run_payment_id("prn_1", "pty_a", 0);
        assert!(first.starts_with("pay_"));
        assert_eq!(first.len(), 28);
        assert_eq!(first, run_payment_id("prn_1", "pty_a", 0));
        assert_ne!(first, run_payment_id("prn_1", "pty_a", 1));
    }
}
