//! Approving and paying a pay run (`services/weldhr/payroll/approve.ts`).
//!
//! Approval is one go: check the calculation is still current, then claim
//! the run (calculated → approved) together with numbering and finalising
//! its payslips in ONE atomic write, render each PDF into storage, meter
//! each payslip for billing, post the journal to WeldBooks, create or
//! refresh the affected filings. Everything after the claim is retryable on
//! its own and none of it undoes the approval when it fails.

use std::collections::{HashMap, HashSet};

use serde_json::{Value, json};
use weldsuite_db::{PgPool, encrypt_field, js_row};
use weldsuite_kit::generate_id;

use super::Deps;
use super::calculate::{data_version, run_inputs_stamp};
use super::employees::{bank_of, decrypt_sensitive};
use super::filings::ensure_filings_for_run;
use super::journal::{JournalOutcome, post_run_journal};
use super::notifier::{PayslipReady, language_of, my_payroll_url, payslip_ready};
use super::payslips::{employees_to_notify, employer_by_id, render_and_store_payslip};
use super::runs::{
    assert_correction_in_year, four_eyes_blocks, included_employee_ids, int_of, payslip_sql,
    require_run, s,
};
use super::ytd::{final_payslips_by_employee, latest_by_approval, number_key};
use crate::employees::display_name_of;
use crate::{Caller, HrError, HrState, locale_compare, now};

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
        let numbers: Vec<Option<String>> = sqlx::query_scalar(
            "select number from hr_payslips where employer_id = $1 and number like $2",
        )
        .bind(employer_id)
        .bind(format!("{year}-%"))
        .fetch_all(db)
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

fn is_unique_violation(error: &HrError) -> bool {
    matches!(error, HrError::Database(e) if e.as_database_error().and_then(sqlx::error::DatabaseError::code).is_some_and(|c| c == "23505"))
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
    let Some(employer) = employer_by_id(db, s(&run, "employerId")).await? else {
        return Err(HrError::not_found(
            "Payroll employer",
            s(&run, "employerId"),
        ));
    };
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
    let drafts: Vec<Value> =
        sqlx::query_scalar(payslip_sql("s.run_id = $1 and s.status = 'draft'"))
            .bind(run_id)
            .fetch_all(db)
            .await?
            .into_iter()
            .map(js_row)
            .collect();
    if drafts.is_empty() {
        return Err(HrError::payroll(
            "RUN_EMPTY",
            "This run has no payslips to approve",
            409,
        ));
    }
    assert_calculation_current(db, &run, &employer, &drafts, &included).await?;

    let ids: Vec<&str> = drafts.iter().map(|d| s(d, "employeeId")).collect();
    let people: Vec<Value> =
        sqlx::query_scalar("select to_jsonb(e) from hr_employees e where e.id = any($1)")
            .bind(&ids)
            .fetch_all(db)
            .await?
            .into_iter()
            .map(js_row)
            .collect();
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

    let at = now();
    let mut tx = db.begin().await?;
    sqlx::query(
        "update hr_pay_runs set status = 'approved', approved_by = $2, approved_at = $3::timestamp, updated_at = $3::timestamp
         where id = $1 and status = 'calculated'",
    )
    .bind(run_id)
    .bind(user_id)
    .bind(&at)
    .execute(&mut *tx)
    .await?;
    for slip in &ordered {
        sqlx::query(
            "update hr_payslips set status = 'final', number = $2,
               snapshot = snapshot || jsonb_build_object('bankEncrypted', $3::text), updated_at = $4::timestamp
             where id = $1 and status = 'draft' and exists (
               select 1 from hr_pay_runs r where r.id = $5 and r.status = 'approved' and r.approved_by = $6
                 and r.approved_at = $4::timestamp)",
        )
        .bind(s(slip, "id"))
        .bind(numbers.get(s(slip, "id")))
        .bind(sealed.get(s(slip, "employeeId")).cloned().flatten())
        .bind(&at)
        .bind(run_id)
        .bind(user_id)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;

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
    let finals: Vec<Value> =
        sqlx::query_scalar(payslip_sql("s.run_id = $1 and s.status = 'final'"))
            .bind(run_id)
            .fetch_all(db)
            .await?
            .into_iter()
            .map(js_row)
            .collect();
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
            for slip in &finals {
                let metered = sqlx::query(
                    "insert into payroll_usage_events (id, workspace_id, month, country, employer_id, run_id, payslip_id)
                     values ($1, $2, $3, $4, $5, $6, $7) on conflict do nothing",
                )
                .bind(generate_id("pue"))
                .bind(&deps.workspace_id)
                .bind(s(&run, "payDate").get(0..7).unwrap_or(""))
                .bind(s(&run, "country"))
                .bind(s(&employer, "id"))
                .bind(run_id)
                .bind(s(slip, "id"))
                .execute(master)
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
    let at = now();
    let paid_at = input["paidOn"]
        .as_str()
        .filter(|v| !v.is_empty())
        .map_or_else(|| at.clone(), |d| format!("{d}T12:00:00.000Z"));
    let refs: Vec<Option<String>> = sqlx::query_scalar(
        "select source_ref from hr_pay_run_inputs where run_id = $1 and source = 'declaration'",
    )
    .bind(run_id)
    .fetch_all(db)
    .await?;
    let declaration_ids: Vec<String> = refs
        .into_iter()
        .flatten()
        .filter(|r| !r.is_empty())
        .collect();
    sqlx::query(
        "update hr_pay_runs set status = 'paid', paid_by = $2, paid_at = $3::timestamp, updated_at = $4::timestamp
         where id = $1 and status = 'approved'",
    )
    .bind(run_id)
    .bind(user_id)
    .bind(&paid_at)
    .bind(&at)
    .execute(db)
    .await?;
    let mut paid = vec![];
    if !declaration_ids.is_empty() {
        paid = sqlx::query_scalar(
            "update hr_declarations set status = 'paid', paid_by = $2, paid_at = $3::timestamp, updated_at = $4::timestamp
             where id = any($1) and status = 'approved' returning id",
        )
        .bind(&declaration_ids)
        .bind(user_id)
        .bind(&paid_at)
        .bind(&at)
        .fetch_all(db)
        .await?;
    }
    Ok((require_run(db, run_id).await?, paid))
}
