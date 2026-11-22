//! Approving and paying a pay run (`services/weldhr/payroll/approve.ts`).
//!
//! Approval is one go: check the calculation is still current, then claim
//! the run (calculated → approved) together with numbering and finalising
//! its payslips in ONE atomic write, render each PDF into storage, meter
//! each payslip for billing, post the journal to WeldBooks, create or
//! refresh the affected filings. Everything after the claim is retryable on
//! its own and none of it undoes the approval when it fails.

use std::collections::{HashMap, HashSet};

use sea_orm::sea_query::{Expr, OnConflict, Query};
use sea_orm::{ActiveValue::Set, ColumnTrait, Condition, EntityTrait, QueryFilter, QuerySelect};
use serde_json::{Value, json};
use time::{OffsetDateTime, PrimitiveDateTime};
use weldsuite_db::{OrmConn, PgPool, atomically_with, encrypt_field, orm, utc_timestamp};
use weldsuite_events::iso_timestamp;
use weldsuite_kit::generate_id;
use weldsuite_schema::master::payroll_usage_events;
use weldsuite_schema::tenant::{hr_declarations, hr_pay_run_inputs, hr_pay_runs, hr_payslips};

use super::Deps;
use super::calculate::{data_version, run_inputs_stamp};
use super::employees::{bank_of, decrypt_sensitive, employee_rows};
use super::employer_context::load_employer_for_payroll;
use super::filings::ensure_filings_for_run;
use super::journal::{JournalOutcome, post_run_journal};
use super::notifier::{PayslipReady, language_of, my_payroll_url, payslip_ready};
use super::payslips::{employees_to_notify, render_and_store_payslip};
use super::runs::{
    assert_correction_in_year, four_eyes_blocks, included_employee_ids, int_of, payslip_rows,
    require_run, s,
};
use super::ytd::{final_payslips_by_employee, latest_by_approval, number_key};
use crate::employees::{display_name_of, pg_date};
use crate::{Caller, HrError, HrState, locale_compare};

/// `ApproveResult`.
pub(crate) struct ApproveResult {
    pub(crate) run: Value,
    /// (id, employee id, number).
    pub(crate) payslips: Vec<(String, String, String)>,
    /// (id, created).
    pub(crate) filings: Vec<(String, bool)>,
    pub(crate) journal: JournalOutcome,
}

/// `assignNumbers(db, employerId, slips)`: the next free `<year>-<seq>`
/// numbers per tax year, in the order of `slips`.
async fn assign_numbers(
    db: &PgPool,
    employer_id: &str,
    slips: &[&Value],
) -> Result<HashMap<String, String>, HrError> {
    let mut next: HashMap<i64, i64> = HashMap::new();
    for slip in slips {
        let year = int_of(slip, "taxYear");
        if next.contains_key(&year) {
            continue;
        }
        let numbers: Vec<Option<String>> = hr_payslips::Entity::find()
            .select_only()
            .column(hr_payslips::Column::Number)
            .filter(hr_payslips::Column::EmployerId.eq(employer_id))
            .filter(hr_payslips::Column::Number.like(format!("{year}-%")))
            .into_tuple()
            .all(&orm(db))
            .await?;
        let max = numbers.iter().fold(0, |max, n| {
            max.max(number_key(n.as_deref()).map_or(0, |(_, seq)| seq))
        });
        next.insert(year, max + 1);
    }
    let mut out = HashMap::new();
    for slip in slips {
        let year = int_of(slip, "taxYear");
        let seq = next.get(&year).copied().unwrap_or(1);
        next.insert(year, seq + 1);
        out.insert(s(slip, "id").to_owned(), format!("{year}-{seq:04}"));
    }
    Ok(out)
}

fn stale(message: &str, details: Value) -> HrError {
    HrError::Payroll {
        code: "RECALCULATE_REQUIRED".into(),
        message: message.into(),
        status: 409,
        details: Some(details),
    }
}

/// `assertCalculationCurrent(db, run, employer, drafts, included)`.
async fn assert_calculation_current(
    db: &PgPool,
    run: &Value,
    employer: &Value,
    drafts: &[Value],
    included: &[String],
) -> Result<(), HrError> {
    let mut draft_ids: Vec<String> = vec![];
    for draft in drafts {
        let id = s(draft, "employeeId").to_owned();
        if !draft_ids.contains(&id) {
            draft_ids.push(id);
        }
    }
    let included_set: HashSet<&String> = included.iter().collect();
    let mut differing: Vec<String> = included
        .iter()
        .filter(|id| !draft_ids.contains(id))
        .cloned()
        .collect();
    differing.extend(
        draft_ids
            .iter()
            .filter(|id| !included_set.contains(id))
            .cloned(),
    );
    if !differing.is_empty() {
        return Err(stale(
            "The people in this run changed after it was calculated (someone joined, left, was paused or moved to another schedule). Calculate it again before approving.",
            json!({ "reason": "employees_changed", "employeeIds": differing }),
        ));
    }
    if drafts.iter().any(|d| {
        d["payDate"] != run["payDate"]
            || d["periodStart"] != run["periodStart"]
            || d["periodEnd"] != run["periodEnd"]
            || int_of(d, "taxYear") != int_of(run, "taxYear")
    }) {
        return Err(stale(
            "The period or pay date of this run changed after it was calculated. Calculate it again before approving.",
            json!({ "reason": "period_changed" }),
        ));
    }
    let mut everyone = draft_ids.clone();
    for id in included {
        if !everyone.contains(id) {
            everyone.push(id.clone());
        }
    }
    let mut versions: Vec<String> = drafts
        .iter()
        .map(|d| {
            d["snapshot"]["dataVersion"]
                .as_str()
                .unwrap_or("")
                .to_owned()
        })
        .collect();
    versions.sort();
    let calculated_against = versions.first().cloned().unwrap_or_default();
    if data_version(db, s(employer, "id"), &everyone).await? > calculated_against {
        return Err(stale(
            "Employee or employer data changed after this run was calculated. Calculate it again before approving.",
            json!({ "reason": "data_changed" }),
        ));
    }
    let stamp = run_inputs_stamp(db, s(run, "id")).await?;
    if drafts
        .iter()
        .any(|d| d["snapshot"]["inputsStamp"].as_str() != Some(stamp.as_str()))
    {
        return Err(stale(
            "The inputs of this run changed after it was calculated. Calculate it again before approving.",
            json!({ "reason": "inputs_changed" }),
        ));
    }
    let ids: Vec<String> = drafts
        .iter()
        .map(|d| s(d, "employeeId").to_owned())
        .collect();
    let correction = run["kind"] == "correction";
    let mut current: HashMap<i64, HashMap<String, Vec<Value>>> = HashMap::new();
    let mut years: Vec<i64> = vec![];
    for draft in drafts {
        let year = int_of(draft, "taxYear");
        if !years.contains(&year) {
            years.push(year);
        }
    }
    for year in years {
        current.insert(
            year,
            final_payslips_by_employee(db, &ids, s(employer, "id"), year).await?,
        );
        if !correction {
            current.insert(
                year - 1,
                final_payslips_by_employee(db, &ids, s(employer, "id"), year - 1).await?,
            );
        }
    }
    let tip_of = |year: i64, employee: &str| -> Value {
        current
            .get(&year)
            .and_then(|m| m.get(employee))
            .and_then(|rows| latest_by_approval(rows))
            .map_or(Value::Null, |t| t["id"].clone())
    };
    let mut behind: Vec<String> = vec![];
    for draft in drafts {
        let chain = &draft["snapshot"]["chain"];
        let year = int_of(draft, "taxYear");
        let employee = s(draft, "employeeId");
        let tip_now = tip_of(year, employee);
        let previous_now = if correction {
            Value::Null
        } else {
            tip_of(year - 1, employee)
        };
        let or_null = |v: Option<&Value>| v.cloned().unwrap_or(Value::Null);
        if !chain.is_object()
            || or_null(chain.get("tipId")) != tip_now
            || or_null(chain.get("previousYearTipId")) != previous_now
        {
            behind.push(employee.to_owned());
        }
    }
    if !behind.is_empty() {
        return Err(stale(
            "Another payslip was approved for the same employee after this run was calculated, so its year-to-date figures are out of date. Calculate it again before approving.",
            json!({ "reason": "ytd_changed", "employeeIds": behind }),
        ));
    }
    Ok(())
}

struct Approved {
    run: Value,
    employer: Value,
    finals: Vec<Value>,
}

/// The run's payslips with this status (`s.run_id = $1 and s.status = $2`).
fn run_payslips(run_id: &str, status: &str) -> sea_orm::Select<hr_payslips::Entity> {
    hr_payslips::Entity::find()
        .filter(hr_payslips::Column::RunId.eq(run_id))
        .filter(hr_payslips::Column::Status.eq(status))
}

/// The claim, in ONE transaction: the run calculated → approved, then each
/// draft payslip (`finalise`: id, number, sealed account) final with its
/// number and the account it is paid to, only while the run is still the
/// one this approval wrote (same approver, same stamp).
async fn claim_run(
    db: &PgPool,
    run_id: &str,
    user_id: &str,
    at: PrimitiveDateTime,
    finalise: Vec<(String, Option<String>, Option<String>)>,
) -> Result<(), HrError> {
    let run_id = run_id.to_owned();
    let user_id = user_id.to_owned();
    atomically_with(db, |tx| {
        Box::pin(async move {
            let tx = OrmConn::new(tx);
            hr_pay_runs::Entity::update_many()
                .col_expr(hr_pay_runs::Column::Status, Expr::value("approved"))
                .col_expr(
                    hr_pay_runs::Column::ApprovedBy,
                    Expr::value(user_id.as_str()),
                )
                .col_expr(hr_pay_runs::Column::ApprovedAt, Expr::value(at))
                .col_expr(hr_pay_runs::Column::UpdatedAt, Expr::value(at))
                .filter(hr_pay_runs::Column::Id.eq(run_id.as_str()))
                .filter(hr_pay_runs::Column::Status.eq("calculated"))
                .exec(&tx)
                .await?;
            // `exists (select 1 from hr_pay_runs r where r.id = … and r.status = 'approved' and …)`.
            let still_ours = Query::select()
                .expr(Expr::val(1))
                .from(hr_pay_runs::Entity)
                .cond_where(
                    Condition::all()
                        .add(hr_pay_runs::Column::Id.eq(run_id.as_str()))
                        .add(hr_pay_runs::Column::Status.eq("approved"))
                        .add(hr_pay_runs::Column::ApprovedBy.eq(user_id.as_str()))
                        .add(hr_pay_runs::Column::ApprovedAt.eq(at)),
                )
                .to_owned();
            for (id, number, sealed) in finalise {
                // `snapshot || jsonb_build_object('bankEncrypted', $3::text)`.
                let snapshot = sea_orm::sea_query::extension::postgres::PgExpr::concat(
                    Expr::col((hr_payslips::Entity, hr_payslips::Column::Snapshot)),
                    Expr::value(json!({ "bankEncrypted": sealed })),
                );
                hr_payslips::Entity::update_many()
                    .col_expr(hr_payslips::Column::Status, Expr::value("final"))
                    .col_expr(hr_payslips::Column::Number, Expr::value(number))
                    .col_expr(hr_payslips::Column::Snapshot, snapshot)
                    .col_expr(hr_payslips::Column::UpdatedAt, Expr::value(at))
                    .filter(hr_payslips::Column::Id.eq(id))
                    .filter(hr_payslips::Column::Status.eq("draft"))
                    .filter(Expr::exists(still_ours.clone()))
                    .exec(&tx)
                    .await?;
            }
            Ok::<_, HrError>(())
        })
    })
    .await
}

fn is_unique_violation(error: &HrError) -> bool {
    matches!(error, HrError::Database(e) if weldsuite_db::is_unique_violation(e))
}

/// `claimAndFinalise(db, runId, deps, ctx)`: one attempt.
#[allow(clippy::too_many_lines)]
async fn claim_and_finalise(
    db: &PgPool,
    run_id: &str,
    deps: &Deps,
    user_id: &str,
) -> Result<Approved, HrError> {
    let run = require_run(db, run_id).await?;
    let status = s(&run, "status");
    if status != "calculated" {
        return Err(HrError::payroll(
            "RUN_NOT_CALCULATED",
            format!("This pay run is {status}; only a calculated run can be approved"),
            409,
        ));
    }
    let errors: Vec<Value> = run["issues"]
        .as_array()
        .map(|i| {
            i.iter()
                .filter(|x| x["severity"] == "error")
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    if !errors.is_empty() {
        let plural = if errors.len() == 1 { "" } else { "s" };
        return Err(HrError::Payroll {
            code: "RUN_HAS_ERRORS".into(),
            message: format!(
                "Resolve the {} error{plural} in this run before approving it",
                errors.len()
            ),
            status: 409,
            details: Some(json!({ "issues": errors })),
        });
    }
    let employer = load_employer_for_payroll(db, s(&run, "employerId"), &deps.keyring)
        .await?
        .row;
    if four_eyes_blocks(Some(&employer), &run, user_id) {
        return Err(HrError::payroll(
            "FOUR_EYES",
            "This employer requires a second person to approve: the member who calculated the run cannot approve it",
            409,
        ));
    }
    if run["kind"] == "correction" {
        assert_correction_in_year(int_of(&run, "taxYear"), s(&run, "payDate"))?;
    }
    let included = included_employee_ids(db, &run).await?;
    let drafts = payslip_rows(&orm(db), run_payslips(run_id, "draft")).await?;
    if drafts.is_empty() {
        return Err(HrError::payroll(
            "RUN_EMPTY",
            "This run has no payslips to approve",
            409,
        ));
    }
    assert_calculation_current(db, &run, &employer, &drafts, &included).await?;

    let ids: Vec<&str> = drafts.iter().map(|d| s(d, "employeeId")).collect();
    let people = employee_rows(db, &ids).await?;
    let name_of = |id: &str| {
        people
            .iter()
            .find(|p| p["id"] == id)
            .map(display_name_of)
            .unwrap_or_default()
    };
    let mut ordered: Vec<&Value> = drafts.iter().collect();
    ordered
        .sort_by(|a, b| locale_compare(&name_of(s(a, "employeeId")), &name_of(s(b, "employeeId"))));
    let numbers = assign_numbers(db, s(&employer, "id"), &ordered).await?;

    // The account each payslip is paid to is frozen now, sealed with the keyring.
    let mut sealed: HashMap<String, Option<String>> = HashMap::new();
    for person in &people {
        let bank = bank_of(&decrypt_sensitive(person, &deps.keyring)?);
        let seal = match bank {
            Some(bank) => Some(
                encrypt_field(&bank.to_string(), &deps.keyring)
                    .map_err(|e| HrError::internal(e.to_string()))?,
            ),
            None => None,
        };
        sealed.insert(s(person, "id").to_owned(), seal);
    }

    // One instant: the stamp written (`$n::timestamp` of the ISO text) and the text compared after.
    let instant = OffsetDateTime::now_utc();
    let at = iso_timestamp(instant);
    // (id, number, the sealed account) of each payslip, in numbering order.
    let finalise: Vec<(String, Option<String>, Option<String>)> = ordered
        .iter()
        .map(|slip| {
            (
                s(slip, "id").to_owned(),
                numbers.get(s(slip, "id")).cloned(),
                sealed.get(s(slip, "employeeId")).cloned().flatten(),
            )
        })
        .collect();
    claim_run(db, run_id, user_id, utc_timestamp(instant), finalise).await?;

    let after = require_run(db, run_id).await?;
    let stamp = |v: &Value| v.as_str().map(|t| t.trim_end_matches('Z').to_owned());
    if after["status"] != "approved"
        || after["approvedBy"] != user_id
        || stamp(&after["approvedAt"]) != stamp(&json!(at))
    {
        return Err(HrError::conflict(
            "This pay run was approved or changed by someone else",
        ));
    }
    let finals = payslip_rows(&orm(db), run_payslips(run_id, "final")).await?;
    Ok(Approved {
        run: after,
        employer,
        finals,
    })
}

/// `approveRun(db, runId, deps, { userId })`.
pub(crate) async fn approve_run(
    state: &HrState,
    caller: &Caller,
    run_id: &str,
    deps: &Deps,
) -> Result<ApproveResult, HrError> {
    let db = &caller.db;
    let user_id = caller.user_id.as_str();
    let mut attempt = 1;
    let Approved {
        run,
        employer,
        finals,
    } = loop {
        match claim_and_finalise(db, run_id, deps, user_id).await {
            Ok(approved) => break approved,
            Err(error) if is_unique_violation(&error) => {
                if attempt >= 3 {
                    return Err(HrError::conflict(
                        "Another pay run of this employer is being approved right now. Try again in a moment.",
                    ));
                }
                attempt += 1;
            }
            Err(error) => return Err(error),
        }
    };

    for slip in &finals {
        if let Err(error) = render_and_store_payslip(db, slip, deps).await {
            tracing::error!(?error, "[payroll] could not render a payslip PDF");
        }
    }

    // Billing: every final payslip of a regular or off-cycle run.
    if run["kind"] != "correction" {
        if let Some(master) = &deps.master {
            let master = orm(master);
            for slip in &finals {
                let metered =
                    payroll_usage_events::Entity::insert(payroll_usage_events::ActiveModel {
                        id: Set(generate_id("pue")),
                        workspace_id: Set(deps.workspace_id.clone()),
                        month: Set(s(&run, "payDate").get(0..7).unwrap_or("").to_owned()),
                        country: Set(s(&run, "country").to_owned()),
                        employer_id: Set(s(&employer, "id").to_owned()),
                        run_id: Set(run_id.to_owned()),
                        payslip_id: Set(s(slip, "id").to_owned()),
                        ..Default::default()
                    })
                    .on_conflict(OnConflict::new().do_nothing().to_owned())
                    .exec_without_returning(&master)
                    .await;
                if let Err(error) = metered {
                    tracing::error!(%error, "[payroll] could not meter payslips");
                    break;
                }
            }
        } else {
            tracing::error!("[payroll] could not meter payslips: no master database");
        }
    }

    let journal = post_run_journal(state, db, run_id, deps, Some(user_id)).await?;
    let filings = ensure_filings_for_run(db, &employer, &finals, Some(user_id)).await?;

    // Best-effort "your payslip is ready".
    if state.mail.is_some() {
        let ids: Vec<String> = finals
            .iter()
            .map(|x| s(x, "employeeId").to_owned())
            .collect();
        match employees_to_notify(db, &ids).await {
            Ok(recipients) => {
                let url = my_payroll_url(caller);
                let lang = language_of(&employer);
                for (_, email, name) in recipients {
                    payslip_ready(
                        state,
                        &url,
                        PayslipReady {
                            email,
                            name,
                            pay_date: s(&run, "payDate").to_owned(),
                            employer_name: s(&employer, "name").to_owned(),
                            lang,
                        },
                    )
                    .await;
                }
            }
            Err(error) => tracing::error!(?error, "[payroll] payslip notifications failed"),
        }
    }

    Ok(ApproveResult {
        run: require_run(db, run_id).await?,
        payslips: finals
            .iter()
            .map(|x| {
                (
                    s(x, "id").to_owned(),
                    s(x, "employeeId").to_owned(),
                    x["number"].as_str().unwrap_or("").to_owned(),
                )
            })
            .collect(),
        filings,
        journal,
    })
}

/// `markRunPaid(db, runId, input, ctx)`: the run and the expense
/// declarations it reimbursed.
pub(crate) async fn mark_run_paid(
    db: &PgPool,
    run_id: &str,
    input: &Value,
    user_id: &str,
) -> Result<(Value, Vec<String>), HrError> {
    let run = require_run(db, run_id).await?;
    let status = s(&run, "status");
    if status != "approved" {
        return Err(HrError::conflict(format!(
            "This pay run is {status}; only an approved run can be marked as paid"
        )));
    }
    let at = utc_timestamp(OffsetDateTime::now_utc());
    // `${paidOn}T12:00:00.000Z` as a `timestamp`: noon of that day.
    let paid_at = match input["paidOn"].as_str().filter(|v| !v.is_empty()) {
        Some(day) => PrimitiveDateTime::new(pg_date(day)?, time::macros::time!(12:00)),
        None => at,
    };
    let orm = orm(db);
    let refs: Vec<Option<String>> = hr_pay_run_inputs::Entity::find()
        .select_only()
        .column(hr_pay_run_inputs::Column::SourceRef)
        .filter(hr_pay_run_inputs::Column::RunId.eq(run_id))
        .filter(hr_pay_run_inputs::Column::Source.eq("declaration"))
        .into_tuple()
        .all(&orm)
        .await?;
    let declaration_ids: Vec<String> = refs
        .into_iter()
        .flatten()
        .filter(|r| !r.is_empty())
        .collect();
    hr_pay_runs::Entity::update_many()
        .col_expr(hr_pay_runs::Column::Status, Expr::value("paid"))
        .col_expr(hr_pay_runs::Column::PaidBy, Expr::value(user_id))
        .col_expr(hr_pay_runs::Column::PaidAt, Expr::value(paid_at))
        .col_expr(hr_pay_runs::Column::UpdatedAt, Expr::value(at))
        .filter(hr_pay_runs::Column::Id.eq(run_id))
        .filter(hr_pay_runs::Column::Status.eq("approved"))
        .exec(&orm)
        .await?;
    let mut paid = vec![];
    if !declaration_ids.is_empty() {
        paid = hr_declarations::Entity::update_many()
            .col_expr(hr_declarations::Column::Status, Expr::value("paid"))
            .col_expr(hr_declarations::Column::PaidBy, Expr::value(user_id))
            .col_expr(hr_declarations::Column::PaidAt, Expr::value(paid_at))
            .col_expr(hr_declarations::Column::UpdatedAt, Expr::value(at))
            .filter(hr_declarations::Column::Id.is_in(&declaration_ids))
            .filter(hr_declarations::Column::Status.eq("approved"))
            .exec_with_returning(&orm)
            .await?
            .into_iter()
            .map(|declaration| declaration.id)
            .collect();
    }
    Ok((require_run(db, run_id).await?, paid))
}
