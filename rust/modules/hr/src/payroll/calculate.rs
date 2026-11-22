//! Calculating a pay run (`services/weldhr/payroll/calculate.ts`): for every
//! included employee build the engine's `PayslipInput` from the database,
//! call the engine, and store draft payslips with a snapshot of exactly
//! what went in. Correction runs recalculate the corrected period and store
//! only the difference (corrections.rs).

use std::collections::{HashMap, HashSet};

use sea_orm::sea_query::{Expr, Func, IntoColumnRef, OnConflict, Query};
use sea_orm::{
    ActiveValue::Set, ColumnTrait, ConnectionTrait, EntityTrait, QueryFilter, QuerySelect,
};
use serde_json::{Map, Value, json};
use time::{OffsetDateTime, PrimitiveDateTime};
use weldsuite_db::{Keyring, OrmConn, PgPool, atomically_with, orm, utc_timestamp};
use weldsuite_kit::generate_id;
use weldsuite_payroll_domain::money::to_cents_text;
use weldsuite_payroll_domain::nl::{
    nl_annual_wage_for_special_rewards, nl_holiday_allowance_balance,
};
use weldsuite_payroll_domain::periods::periods_per_year;
use weldsuite_payroll_domain::types::{PayFrequency, PayslipInput, PayslipResult, Ytd};
use weldsuite_payroll_domain::{PayrollError, calculate_payslip};
use weldsuite_schema::tenant::{
    hr_compensations, hr_employees, hr_pay_components, hr_pay_run_inputs, hr_pay_runs,
    hr_pay_schedules, hr_payroll_employers, hr_payroll_profiles, hr_payslips, hr_tax_elections,
};

use super::common::{employee_issue, num, push_issue, sort_issues};
use super::corrections::{
    CorrectionBase, Recalculated, Totals, correction_from, result_totals, snapshot_ytd,
};
use super::employees::{
    EmployeePayrollData, compensation_on, components_overlapping, election_of, elections_in_force,
    load_employee_payroll_data, pg_numeric, readiness_issues,
};
use super::employer_context::load_employer_for_payroll;
use super::employers::{employer_issues, read_employer_bank, work_states_of};
use super::runs::{
    assert_editable, included_employee_ids, int_of, payslip_rows, profile_window, require_run,
    run_input_rows, s,
};
use super::ytd::{
    carried_over_ytd, employees_with_final_payslips, final_payslips_by_employee,
    latest_by_approval, ytd_of,
};
use crate::employees::{js_timestamp, pg_date};
use crate::{HrError, js_round, locale_compare};

const RUN_CHANGED: &str =
    "This pay run was approved, cancelled or changed by someone else. Reload it and try again.";

fn n(x: f64) -> Value {
    weldsuite_core_domain::js::number_value(x)
}

/// `x ?? fallback` on a JSON field: `None` for a missing key or `null`.
fn present(value: Option<&Value>) -> Option<&Value> {
    value.filter(|v| !v.is_null())
}

fn coalesce(values: &[Option<&Value>]) -> Value {
    values
        .iter()
        .find_map(|v| present(*v))
        .cloned()
        .unwrap_or(Value::Null)
}

/// `Boolean(x)`.
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// `Number(x)`.
fn js_num(value: Option<&Value>) -> f64 {
    match value {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => f64::from(u8::from(*b)),
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => weldsuite_kit::validation::js_number(s),
        Some(_) => f64::NAN,
    }
}

/// `x === undefined || x === null ? null : Number(x)`.
fn num_or_null(value: Option<&Value>) -> Value {
    match present(value) {
        None => Value::Null,
        some => n(js_num(some)),
    }
}

/// `periodOf(run, frequency)`.
pub(crate) fn period_of(
    run: &Value,
    pay_date: &str,
    tax_year: i64,
    frequency: PayFrequency,
) -> Value {
    json!({
        "start": run["periodStart"], "end": run["periodEnd"], "payDate": pay_date, "frequency": frequency.as_str(),
        "taxYear": tax_year, "periodNumber": run["periodNumber"], "periodsPerYear": periods_per_year(frequency),
    })
}

fn run_inputs_of(rows: &[&Value]) -> Vec<Value> {
    rows.iter()
        .map(|row| {
            json!({
                "code": row["code"], "label": row["label"],
                "quantity": num(&row["quantity"]).map_or(Value::Null, n),
                "rate": num(&row["rate"]).map_or(Value::Null, n),
                "amountCents": row["amount"].as_str().map_or(Value::Null, |a| n(to_cents_text(Some(a)).unwrap_or(f64::NAN))),
                "workDate": row["workDate"],
            })
        })
        .collect()
}

/// `Number(x ?? 0)`.
fn num_or_zero(value: Option<&Value>) -> Value {
    match present(value) {
        None => n(0.0),
        some => n(js_num(some)),
    }
}

fn to_w4(data: &Value) -> Value {
    json!({
        "formYear": n(js_num(data.get("formYear"))),
        "filingStatus": data.get("filingStatus").cloned().unwrap_or(Value::Null),
        "multipleJobs": truthy(data.get("multipleJobs")),
        "dependentsAmount": num_or_zero(data.get("dependentsAmount")),
        "otherIncome": num_or_zero(data.get("otherIncome")),
        "deductions": num_or_zero(data.get("deductions")),
        "extraWithholding": num_or_zero(data.get("extraWithholding")),
        "exempt": truthy(data.get("exempt")),
        "allowances": num_or_null(data.get("allowances")),
        "nonresidentAlien": truthy(data.get("nonresidentAlien")),
    })
}

fn to_state_certificate(data: &Value) -> Value {
    json!({
        "filingStatus": coalesce(&[data.get("filingStatus")]),
        "allowances": num_or_null(data.get("allowances")),
        "values": present(data.get("values")).cloned().unwrap_or_else(|| json!({})),
        "extraWithholding": num_or_null(data.get("extraWithholding")),
        "exempt": truthy(data.get("exempt")),
    })
}

/// What `buildPayslipInput` takes besides the employee's data.
pub(crate) struct BuildInputArgs<'a> {
    pub(crate) period: Value,
    pub(crate) employer: &'a Value,
    pub(crate) data: &'a EmployeePayrollData,
    pub(crate) inputs: Vec<&'a Value>,
    pub(crate) ytd: Ytd,
    pub(crate) previous_year_annual_wage_cents: Value,
    pub(crate) holiday_allowance_opening_balance_cents: Value,
    pub(crate) headcount: f64,
}

/// The engine input as TypeScript builds it (what the snapshot stores), and
/// the typed input; `Err` when the stored data does not make one.
pub(crate) struct BuiltInput {
    pub(crate) json: Value,
    pub(crate) typed: Result<PayslipInput, String>,
}

/// `buildPayslipInput(args)`. Compensation must exist.
#[allow(clippy::too_many_lines)]
pub(crate) fn build_payslip_input(args: BuildInputArgs<'_>) -> BuiltInput {
    let BuildInputArgs {
        period,
        employer,
        data,
        inputs,
        ytd,
        ..
    } = &args;
    let profile = data.profile.clone().unwrap_or(Value::Null);
    let period_end = period["end"].as_str().unwrap_or("");
    let period_start = period["start"].as_str().unwrap_or("");
    let comp = compensation_on(&data.compensations, period_end)
        .cloned()
        .unwrap_or(Value::Null);
    let (start, end) = profile_window(&profile, &data.employee);
    let nl = &profile["nl"];
    let compensation = json!({
        "payType": comp["payType"],
        "amount": n(js_num(comp.get("amount"))),
        "period": comp["period"],
        "hoursPerWeek": coalesce(&[comp.get("hoursPerWeek"), nl.get("contractHoursPerWeek"), data.employee.get("weeklyHours")]),
    });
    let components: Vec<Value> = components_overlapping(&data.components, period_start, period_end)
        .iter()
        .map(|c| {
            json!({
                "code": c["code"], "label": c["label"],
                "amountCents": c["amount"].as_str().map_or(Value::Null, |a| n(to_cents_text(Some(a)).unwrap_or(f64::NAN))),
                "params": c["params"],
            })
        })
        .collect();
    let ytd_json = weldsuite_payroll_domain::js::to_value(ytd);
    let mut base = Map::new();
    base.insert("period".into(), period.clone());
    base.insert(
        "employee".into(),
        json!({ "dateOfBirth": coalesce(&[data.sensitive.get("dateOfBirth")]), "startDate": start, "endDate": end }),
    );
    base.insert("compensation".into(), compensation);
    base.insert("components".into(), Value::Array(components));
    base.insert("inputs".into(), Value::Array(run_inputs_of(inputs)));
    base.insert("ytd".into(), ytd_json);

    if employer["country"] == "NL" {
        let settings = &employer["nlSettings"];
        let year = &settings["years"][period["taxYear"].as_i64().unwrap_or(0).to_string()];
        let contract_hours = coalesce(&[
            nl.get("contractHoursPerWeek"),
            data.employee.get("weeklyHours"),
        ]);
        let election = election_of(&data.elections, period_end, "nl_loonheffingskorting", None);
        let expat = &nl["expatRuling"];
        let expat_percent = if truthy(Some(expat))
            && expat["from"].as_str().is_some_and(|f| f <= period_end)
            && (!truthy(expat.get("to")) || expat["to"].as_str().is_some_and(|t| t >= period_start))
        {
            expat.get("percent").cloned().unwrap_or(Value::Null)
        } else {
            Value::Null
        };
        let is_dga = present(nl.get("isDga")).cloned().unwrap_or(json!(false));
        let not_dga = json!(!truthy(Some(&is_dga)));
        let flag = |key: &str, fallback: &Value| {
            present(nl.get(key))
                .cloned()
                .unwrap_or_else(|| fallback.clone())
        };
        base.insert("country".into(), json!("NL"));
        base.insert(
            "employer".into(),
            json!({
                "whkRatePercent": coalesce(&[year.get("whkRate")]),
                "sectorCode": coalesce(&[settings.get("sectorCode")]),
                "aofSmallEmployer": present(year.get("aofSmallEmployer")).cloned().unwrap_or(json!(true)),
                "holidayAllowancePercent": present(settings.get("holidayAllowancePercent")).cloned().unwrap_or(json!(8)),
                "holidayAllowancePayoutMonth": coalesce(&[settings.get("holidayAllowancePayoutMonth")]),
            }),
        );
        let usual = present(nl.get("usualWorkDaysPerWeek"))
            .cloned()
            .unwrap_or_else(|| {
                let short =
                    contract_hours.as_f64().is_some_and(|h| h < 36.0) && !contract_hours.is_null();
                json!(if short { 4 } else { 5 })
            });
        base.insert(
            "nl".into(),
            json!({
                "applyLoonheffingskorting": truthy(election.as_ref().and_then(|e| e["data"].get("applyCredit"))),
                "anonymous": !truthy(data.sensitive.get("nationalId")) || !truthy(data.sensitive.get("idVerifiedAt")),
                "isDga": is_dga,
                "insuredWw": flag("insuredWw", &not_dga),
                "insuredZw": flag("insuredZw", &not_dga),
                "insuredWao": flag("insuredWao", &not_dga),
                "writtenContract": flag("writtenContract", &json!(false)),
                "indefiniteContract": flag("indefiniteContract", &json!(false)),
                "onCall": flag("onCall", &json!(false)),
                "contractHoursPerWeek": contract_hours,
                "expatRulingPercent": expat_percent,
                "previousYearAnnualWageCents": args.previous_year_annual_wage_cents,
                "holidayAllowanceOpeningBalanceCents": args.holiday_allowance_opening_balance_cents,
                "usualWorkDaysPerWeek": usual,
            }),
        );
    } else {
        let settings = &employer["usSettings"];
        let year = period["taxYear"].as_i64().unwrap_or(0).to_string();
        let mut sui = Map::new();
        let mut extra = Map::new();
        if let Some(states) = settings["states"].as_object() {
            for (state, config) in states {
                sui.insert(state.clone(), coalesce(&[config["suiRates"].get(&year)]));
                extra.insert(
                    state.clone(),
                    present(config["extraRates"].get(&year))
                        .cloned()
                        .unwrap_or_else(|| json!({})),
                );
            }
        }
        let us = &profile["us"];
        let work_state = coalesce(&[us.get("workState")]);
        if let Some(state) = work_state.as_str().filter(|s| !s.is_empty())
            && !sui.contains_key(state)
        {
            sui.insert(state.to_owned(), Value::Null);
        }
        let w4 = election_of(&data.elections, period_end, "us_w4", None);
        let mut certificates = Map::new();
        for election in elections_in_force(&data.elections, period_end) {
            if election["kind"] == "us_state_certificate"
                && let Some(state) = election["state"].as_str().filter(|s| !s.is_empty())
            {
                certificates.insert(state.to_owned(), to_state_certificate(&election["data"]));
            }
        }
        let flsa = present(us.get("flsaStatus")).cloned().unwrap_or_else(|| {
            json!(if comp["payType"] == "hourly" {
                "nonexempt"
            } else {
                "exempt"
            })
        });
        let flag = |key: &str| present(us.get(key)).cloned().unwrap_or(json!(false));
        base.insert("country".into(), json!("US"));
        base.insert(
            "employer".into(),
            json!({
                "workweekStartDay": present(settings.get("workweekStartDay")).cloned().unwrap_or(json!(0)),
                "suiRatePercent": sui,
                "extraRates": extra,
                "employeeCountEstimate": present(settings.get("employeeCountEstimate")).cloned().unwrap_or_else(|| n(args.headcount)),
            }),
        );
        base.insert(
            "us".into(),
            json!({
                "workState": work_state,
                "residenceState": coalesce(&[us.get("residenceState")]),
                "flsaStatus": flsa,
                "w4": w4.map_or(Value::Null, |e| to_w4(&e["data"])),
                "stateCertificates": certificates,
                "exemptFica": flag("exemptFica"),
                "exemptFuta": flag("exemptFuta"),
                "statutoryEmployee": flag("statutoryEmployee"),
                "retirementPlan": flag("retirementPlan"),
            }),
        );
    }
    let json = Value::Object(base);
    let typed = serde_json::from_value::<PayslipInput>(json.clone())
        .map_err(|e| e.to_string())
        .map(|mut input| {
            match &mut input {
                PayslipInput::Nl(nl) => nl.ytd = ytd.clone(),
                PayslipInput::Us(us) => us.ytd = ytd.clone(),
            }
            input
        });
    BuiltInput { json, typed }
}

/// What a payslip calculation produced: the engine's result, or the error
/// payslip `safeCalculate` makes of an engine that threw.
pub(crate) struct Outcome {
    pub(crate) lines: Vec<Value>,
    pub(crate) totals: Totals,
    pub(crate) ytd: Ytd,
    pub(crate) filing_data: Value,
    /// `{ severity, code, params? }`.
    pub(crate) issues: Vec<Value>,
    pub(crate) rule_set: String,
}

fn utf16_prefix(text: &str, units: usize) -> String {
    String::from_utf16_lossy(&text.encode_utf16().take(units).collect::<Vec<u16>>())
}

/// `safeCalculate(deps, input)`: an engine that throws makes an error on
/// that payslip, not a failed run.
pub(crate) fn safe_calculate(input: &BuiltInput, ytd: &Ytd) -> Outcome {
    let result: Result<PayslipResult, PayrollError> = match &input.typed {
        Ok(typed) => calculate_payslip(typed),
        Err(message) => Err(PayrollError::new(message.clone())),
    };
    match result {
        Ok(result) => Outcome {
            lines: result
                .lines
                .iter()
                .map(weldsuite_payroll_domain::js::to_value)
                .collect(),
            totals: result_totals(&result),
            ytd: result.ytd.clone(),
            filing_data: weldsuite_payroll_domain::js::to_value(&result.filing_data),
            issues: result
                .issues
                .iter()
                .map(weldsuite_payroll_domain::js::to_value)
                .collect(),
            rule_set: result.rule_set,
        },
        Err(error) => {
            let nl = input.json["country"] == "NL";
            Outcome {
                lines: vec![],
                totals: Totals::default(),
                ytd: ytd.clone(),
                filing_data: if nl {
                    json!({ "kind": "nl" })
                } else {
                    json!({ "kind": "us", "federal": {}, "states": {}, "qualifiedOvertimePremium": 0, "hoursWorked": 0 })
                },
                issues: vec![json!({
                    "severity": "error", "code": "unsupported_tax_year",
                    "params": { "year": input.json["period"]["taxYear"], "message": utf16_prefix(&error.to_string(), 200) },
                })],
                rule_set: "engine-error".into(),
            }
        }
    }
}

/// `asIssues(employeeId, issues)`.
fn as_issues(employee_id: &str, issues: &[Value]) -> Vec<Value> {
    issues
        .iter()
        .map(|i| {
            employee_issue(
                i["severity"].as_str().unwrap_or(""),
                i["code"].as_str().unwrap_or(""),
                employee_id,
                i.get("params").filter(|p| !p.is_null()).cloned(),
            )
        })
        .collect()
}

/// One draft payslip to store.
struct StoredPayslip {
    employee_id: String,
    totals: Totals,
    tax_year: i64,
    pay_date: String,
    lines: Vec<Value>,
    ytd: Value,
    filing_data: Value,
    snapshot: Value,
    issues: Vec<Value>,
    corrects_payslip_id: Option<String>,
}

fn aggregate_totals(slips: &[StoredPayslip]) -> Value {
    let mut t = Totals::default();
    for slip in slips {
        t = t.add(slip.totals, 1.0);
    }
    json!({
        "grossCents": n(t.gross), "netCents": n(t.net), "employeeTaxesCents": n(t.employee_taxes),
        "employeeDeductionsCents": n(t.employee_deductions), "employerTaxesCents": n(t.employer_taxes),
        "reimbursementsCents": n(t.reimbursements), "employerCostCents": n(t.employer_cost),
    })
}

/// One draft payslip as the upsert writes it: the money columns as the
/// `numeric` text of the totals (`$n::numeric`), the dates as `$n::date`.
fn draft_payslip(
    run_id: &str,
    run: &Value,
    employer: &Value,
    slip: &StoredPayslip,
) -> Result<hr_payslips::ActiveModel, HrError> {
    let [
        gross,
        taxable,
        employee_taxes,
        deductions,
        reimbursements,
        net,
        employer_taxes,
        cost,
    ] = slip.totals.columns();
    Ok(hr_payslips::ActiveModel {
        id: Set(generate_id("hrps")),
        run_id: Set(run_id.to_owned()),
        employee_id: Set(slip.employee_id.clone()),
        employer_id: Set(s(employer, "id").to_owned()),
        country: Set(s(run, "country").to_owned()),
        currency: Set(s(run, "currency").to_owned()),
        status: Set("draft".to_owned()),
        period_start: Set(pg_date(s(run, "periodStart"))?),
        period_end: Set(pg_date(s(run, "periodEnd"))?),
        pay_date: Set(pg_date(&slip.pay_date)?),
        tax_year: Set(i32::try_from(slip.tax_year).unwrap_or_default()),
        period_number: Set(i32::try_from(int_of(run, "periodNumber")).unwrap_or_default()),
        gross_pay: Set(pg_numeric(&gross)?),
        taxable_wage: Set(pg_numeric(&taxable)?),
        employee_taxes: Set(pg_numeric(&employee_taxes)?),
        employee_deductions: Set(pg_numeric(&deductions)?),
        reimbursements: Set(pg_numeric(&reimbursements)?),
        net_pay: Set(pg_numeric(&net)?),
        employer_taxes: Set(pg_numeric(&employer_taxes)?),
        employer_cost: Set(pg_numeric(&cost)?),
        lines: Set(Value::Array(slip.lines.clone())),
        ytd: Set(slip.ytd.clone()),
        filing_data: Set(slip.filing_data.clone()),
        snapshot: Set(slip.snapshot.clone()),
        issues: Set(Value::Array(slip.issues.clone())),
        corrects_payslip_id: Set(slip.corrects_payslip_id.clone()),
        ..Default::default()
    })
}

/// In ONE transaction: the run's drafts of people no longer in it (`kept`
/// are the ones calculated) go, then
/// each draft is inserted or, while still a draft, overwritten
/// (`on conflict (run_id, employee_id) do update … where status = 'draft'`).
async fn store_drafts(
    db: &PgPool,
    run_id: &str,
    at: PrimitiveDateTime,
    kept: Vec<String>,
    drafts: Vec<hr_payslips::ActiveModel>,
) -> Result<(), HrError> {
    use hr_payslips::Column;
    let run_id = run_id.to_owned();
    atomically_with(db, |tx| {
        Box::pin(async move {
            let tx = OrmConn::new(tx);
            hr_payslips::Entity::delete_many()
                .filter(Column::RunId.eq(run_id.as_str()))
                .filter(Column::Status.eq("draft"))
                .filter(Column::EmployeeId.is_not_in(kept))
                .exec(&tx)
                .await?;
            for draft in drafts {
                hr_payslips::Entity::insert(draft)
                    .on_conflict(
                        OnConflict::columns([Column::RunId, Column::EmployeeId])
                            .update_columns([
                                Column::EmployerId,
                                Column::Country,
                                Column::Currency,
                                Column::PeriodStart,
                                Column::PeriodEnd,
                                Column::PayDate,
                                Column::TaxYear,
                                Column::PeriodNumber,
                                Column::GrossPay,
                                Column::TaxableWage,
                                Column::EmployeeTaxes,
                                Column::EmployeeDeductions,
                                Column::Reimbursements,
                                Column::NetPay,
                                Column::EmployerTaxes,
                                Column::EmployerCost,
                                Column::Lines,
                                Column::Ytd,
                                Column::FilingData,
                                Column::Snapshot,
                                Column::Issues,
                                Column::CorrectsPayslipId,
                            ])
                            .value(Column::UpdatedAt, Expr::value(at))
                            .action_and_where(Column::Status.eq("draft"))
                            .to_owned(),
                    )
                    .exec_without_returning(&tx)
                    .await?;
            }
            Ok::<_, HrError>(())
        })
    })
    .await
}

/// `claimForCalculation(db, runId)`: draft | calculated → draft, or 409.
async fn claim_for_calculation(db: &PgPool, run_id: &str) -> Result<(), HrError> {
    let claimed = hr_pay_runs::Entity::update_many()
        .col_expr(hr_pay_runs::Column::Status, Expr::value("draft"))
        .col_expr(
            hr_pay_runs::Column::UpdatedAt,
            Expr::value(weldsuite_db::utc_now()),
        )
        .filter(hr_pay_runs::Column::Id.eq(run_id))
        .filter(hr_pay_runs::Column::Status.is_in(["draft", "calculated"]))
        .exec(&orm(db))
        .await?;
    if claimed.rows_affected == 0 {
        return Err(HrError::conflict(RUN_CHANGED));
    }
    Ok(())
}

/// `runInputsStamp(db, runId)`: how many inputs, and when the latest was
/// created or edited.
pub(crate) async fn run_inputs_stamp(db: &PgPool, run_id: &str) -> Result<String, HrError> {
    let rows: Vec<(PrimitiveDateTime, PrimitiveDateTime)> = hr_pay_run_inputs::Entity::find()
        .select_only()
        .columns([
            hr_pay_run_inputs::Column::CreatedAt,
            hr_pay_run_inputs::Column::UpdatedAt,
        ])
        .filter(hr_pay_run_inputs::Column::RunId.eq(run_id))
        .into_tuple()
        .all(&orm(db))
        .await?;
    let mut latest = String::new();
    for (created_at, updated_at) in &rows {
        for at in [created_at, updated_at] {
            // As the row reads it: `toISOString()`.
            if let Value::String(iso) = js_timestamp(Some(*at))
                && iso > latest
            {
                latest = iso;
            }
        }
    }
    Ok(format!("{}|{latest}", rows.len()))
}

/// `(select max(column) from table where filter)`.
fn latest_of(
    column: impl IntoColumnRef,
    table: impl sea_orm::sea_query::IntoTableRef,
    filter: Expr,
) -> Expr {
    Expr::SubQuery(
        None,
        Box::new(
            Query::select()
                .expr(Func::max(Expr::col(column)))
                .from(table)
                .and_where(filter)
                .to_owned()
                .into(),
        ),
    )
}

/// `dataVersion(db, employerId, employeeIds)`: the latest change time across
/// what payroll reads, from the database's own clock.
pub(crate) async fn data_version(
    db: &PgPool,
    employer_id: &str,
    employee_ids: &[String],
) -> Result<String, HrError> {
    // One statement, so every table is read at the same moment.
    let at = Query::select()
        .expr_as(
            Func::greatest([
                latest_of(
                    (
                        hr_payroll_employers::Entity,
                        hr_payroll_employers::Column::UpdatedAt,
                    ),
                    hr_payroll_employers::Entity,
                    hr_payroll_employers::Column::Id.eq(employer_id),
                ),
                latest_of(
                    (hr_employees::Entity, hr_employees::Column::UpdatedAt),
                    hr_employees::Entity,
                    hr_employees::Column::Id.is_in(employee_ids),
                ),
                latest_of(
                    (
                        hr_payroll_profiles::Entity,
                        hr_payroll_profiles::Column::UpdatedAt,
                    ),
                    hr_payroll_profiles::Entity,
                    hr_payroll_profiles::Column::EmployeeId.is_in(employee_ids),
                ),
                latest_of(
                    (
                        hr_compensations::Entity,
                        hr_compensations::Column::UpdatedAt,
                    ),
                    hr_compensations::Entity,
                    hr_compensations::Column::EmployeeId.is_in(employee_ids),
                ),
                latest_of(
                    (
                        hr_pay_components::Entity,
                        hr_pay_components::Column::UpdatedAt,
                    ),
                    hr_pay_components::Entity,
                    hr_pay_components::Column::EmployeeId.is_in(employee_ids),
                ),
                latest_of(
                    (
                        hr_tax_elections::Entity,
                        hr_tax_elections::Column::CreatedAt,
                    ),
                    hr_tax_elections::Entity,
                    hr_tax_elections::Column::EmployeeId.is_in(employee_ids),
                ),
            ]),
            "at",
        )
        .to_owned();
    let at: Option<PrimitiveDateTime> = match orm(db).query_one(&at).await? {
        Some(row) => row.try_get("", "at")?,
        None => None,
    };
    Ok(js_timestamp(at).as_str().unwrap_or("").to_owned())
}

/// `previousFinalNets(db, run, employeeIds)`: net pay (cents) of each
/// employee's previous final, non-correction payslip at the employer.
async fn previous_final_nets(
    db: &PgPool,
    run: &Value,
    employee_ids: &[String],
) -> Result<HashMap<String, f64>, HrError> {
    let mut out = HashMap::new();
    if employee_ids.is_empty() {
        return Ok(out);
    }
    let text = |column: hr_payslips::Column| {
        sea_orm::ExprTrait::cast_as(Expr::col((hr_payslips::Entity, column)), "text")
    };
    let mut rows: Vec<(String, String, String, Option<String>, String)> =
        hr_payslips::Entity::find()
            .select_only()
            .column(hr_payslips::Column::EmployeeId)
            .column_as(text(hr_payslips::Column::NetPay), "net_pay")
            .column_as(text(hr_payslips::Column::PeriodEnd), "period_end")
            .columns([
                hr_payslips::Column::CorrectsPayslipId,
                hr_payslips::Column::RunId,
            ])
            .filter(hr_payslips::Column::EmployeeId.is_in(employee_ids))
            .filter(hr_payslips::Column::EmployerId.eq(s(run, "employerId")))
            .filter(hr_payslips::Column::Status.eq("final"))
            .into_tuple()
            .all(&orm(db))
            .await?;
    rows.retain(|r| r.3.is_none() && r.4 != s(run, "id") && r.2.as_str() < s(run, "periodEnd"));
    rows.sort_by(|a, b| b.2.cmp(&a.2));
    for (employee, net, ..) in rows {
        out.entry(employee)
            .or_insert_with(|| to_cents_text(Some(&net)).unwrap_or(0.0));
    }
    Ok(out)
}

fn frequency_for(
    run: &Value,
    d: &EmployeePayrollData,
    frequencies: &HashMap<String, String>,
) -> PayFrequency {
    let of = |id: Option<&str>| {
        id.filter(|v| !v.is_empty())
            .and_then(|id| frequencies.get(id))
            .and_then(|f| PayFrequency::parse(f))
    };
    of(run["payScheduleId"].as_str())
        .or_else(|| of(d.profile.as_ref().and_then(|p| p["payScheduleId"].as_str())))
        .unwrap_or(PayFrequency::Monthly)
}

fn has_missing_compensation(issues: &[Value]) -> bool {
    issues.iter().any(|i| i["code"] == "missing_compensation")
}

/// Readiness issues not already among `employee_issues` (by code).
fn merge_readiness(employee_issues: &mut Vec<Value>, readiness: &[Value]) {
    for issue in readiness {
        if !employee_issues.iter().any(|i| i["code"] == issue["code"]) {
            employee_issues.push(issue.clone());
        }
    }
}

/// `calculateRun(db, runId, deps, { userId })`.
#[allow(clippy::too_many_lines)]
pub(crate) async fn calculate_run(
    db: &PgPool,
    run_id: &str,
    keyring: &Keyring,
    user_id: &str,
) -> Result<Value, HrError> {
    let run = require_run(db, run_id).await?;
    assert_editable(&run)?;
    let employer = load_employer_for_payroll(db, s(&run, "employerId"), keyring)
        .await?
        .row;
    claim_for_calculation(db, run_id).await?;
    let run = require_run(db, run_id).await?;

    let included = included_employee_ids(db, &run).await?;
    let version = data_version(db, s(&employer, "id"), &included).await?;
    let inputs_stamp = run_inputs_stamp(db, run_id).await?;
    let data = load_employee_payroll_data(db, &included, keyring).await?;
    let data_of = |id: &str| data.iter().find(|d| s(&d.employee, "id") == id);
    let input_rows = if included.is_empty() {
        vec![]
    } else {
        run_input_rows(db, run_id, Some(&included)).await?
    };
    let inputs_of = |id: &str| {
        input_rows
            .iter()
            .filter(|r| r["employeeId"] == id)
            .collect::<Vec<_>>()
    };

    let mut schedule_ids: Vec<String> = vec![];
    for id in std::iter::once(run["payScheduleId"].as_str())
        .chain(
            data.iter()
                .map(|d| d.profile.as_ref().and_then(|p| p["payScheduleId"].as_str())),
        )
        .flatten()
    {
        if !id.is_empty() && !schedule_ids.iter().any(|x| x == id) {
            schedule_ids.push(id.to_owned());
        }
    }
    let frequencies: HashMap<String, String> = if schedule_ids.is_empty() {
        HashMap::new()
    } else {
        hr_pay_schedules::Entity::find()
            .select_only()
            .columns([
                hr_pay_schedules::Column::Id,
                hr_pay_schedules::Column::Frequency,
            ])
            .filter(hr_pay_schedules::Column::Id.is_in(&schedule_ids))
            .into_tuple::<(String, String)>()
            .all(&orm(db))
            .await?
            .into_iter()
            .collect()
    };

    let mut issues: Vec<Value> = vec![];
    let mut slips: Vec<StoredPayslip> = vec![];
    let tax_year = int_of(&run, "taxYear");
    let country = s(&employer, "country").to_owned();

    if run["kind"] == "correction" {
        calculate_corrections(
            db,
            &run,
            &employer,
            &included,
            &data,
            &input_rows,
            &frequencies,
            &mut issues,
            &mut slips,
        )
        .await?;
    } else {
        let chain = final_payslips_by_employee(db, &included, s(&employer, "id"), tax_year).await?;
        let previous_year =
            final_payslips_by_employee(db, &included, s(&employer, "id"), tax_year - 1).await?;
        let ever_paid: HashSet<String> =
            employees_with_final_payslips(db, &included, s(&employer, "id")).await?;
        let previous_nets = previous_final_nets(db, &run, &included).await?;
        for employee_id in &included {
            let Some(d) =
                data_of(employee_id).filter(|d| d.profile.is_some() && d.employer.is_some())
            else {
                issues.push(employee_issue(
                    "error",
                    "employer_incomplete",
                    employee_id,
                    Some(json!({ "field": "payroll_profile" })),
                ));
                continue;
            };
            let readiness = readiness_issues(d, s(&run, "periodEnd"), false, &[]);
            for issue in &readiness {
                push_issue(&mut issues, issue.clone());
            }
            if has_missing_compensation(&readiness) {
                continue;
            }
            let empty = vec![];
            let tip = latest_by_approval(chain.get(employee_id).unwrap_or(&empty));
            let last_year_tip =
                latest_by_approval(previous_year.get(employee_id).unwrap_or(&empty));
            let ytd = match tip {
                Some(tip) => ytd_of(tip),
                None if country == "US" => carried_over_ytd(last_year_tip),
                None => Ytd::new(),
            };
            let nl = country == "NL";
            let built = build_payslip_input(BuildInputArgs {
                period: period_of(
                    &run,
                    s(&run, "payDate"),
                    tax_year,
                    frequency_for(&run, d, &frequencies),
                ),
                employer: &employer,
                data: d,
                inputs: inputs_of(employee_id),
                ytd: ytd.clone(),
                previous_year_annual_wage_cents: match last_year_tip {
                    Some(t) if nl => {
                        nl_annual_wage_for_special_rewards(&ytd_of(t)).map_or(Value::Null, n)
                    }
                    _ => Value::Null,
                },
                holiday_allowance_opening_balance_cents: match last_year_tip {
                    Some(t) if nl => n(nl_holiday_allowance_balance(&ytd_of(t))),
                    _ => Value::Null,
                },
                headcount: included.len() as f64,
            });
            let result = safe_calculate(&built, &ytd);
            let mut employee_issues = as_issues(employee_id, &result.issues);
            merge_readiness(&mut employee_issues, &readiness);
            if !ever_paid.contains(employee_id) {
                employee_issues.push(employee_issue(
                    "warning",
                    "first_payslip",
                    employee_id,
                    None,
                ));
            }
            if run["kind"] == "regular"
                && let Some(previous) = previous_nets.get(employee_id).copied().filter(|p| *p > 0.0)
            {
                let change = (result.totals.net - previous).abs() / previous;
                if change > 0.2 {
                    employee_issues.push(employee_issue(
                        "warning",
                        "large_change",
                        employee_id,
                        Some(json!({ "percent": n(js_round(change * 100.0)) })),
                    ));
                }
            }
            for issue in &employee_issues {
                push_issue(&mut issues, issue.clone());
            }
            let mut input_json = built.json;
            input_json["ytd"] = weldsuite_payroll_domain::js::to_value(&ytd);
            slips.push(StoredPayslip {
                employee_id: employee_id.clone(),
                totals: result.totals,
                tax_year,
                pay_date: s(&run, "payDate").to_owned(),
                lines: result.lines,
                ytd: weldsuite_payroll_domain::js::to_value(&result.ytd),
                filing_data: result.filing_data,
                snapshot: json!({
                    "input": input_json,
                    "ruleSet": result.rule_set,
                    "dataVersion": "",
                    "inputsStamp": "",
                    "chain": { "tipId": tip.map(|t| t["id"].clone()), "previousYearTipId": last_year_tip.map(|t| t["id"].clone()) },
                }),
                issues: sort_issues(employee_issues),
                corrects_payslip_id: None,
            });
        }
    }
    for slip in &mut slips {
        slip.snapshot["dataVersion"] = json!(version);
        slip.snapshot["inputsStamp"] = json!(inputs_stamp);
    }

    // Run-level checks: the employer once for the whole run.
    let bank = read_employer_bank(&employer, keyring)?;
    let profiles: Vec<Value> = data
        .iter()
        .filter_map(|d| d.profile.as_ref().map(|p| json!({ "us": p["us"] })))
        .collect();
    for issue in employer_issues(
        &employer,
        bank.as_ref(),
        &work_states_of(&profiles),
        tax_year,
    ) {
        push_issue(&mut issues, issue);
    }

    let at = utc_timestamp(OffsetDateTime::now_utc());
    let kept: Vec<String> = slips.iter().map(|x| x.employee_id.clone()).collect();
    let drafts = slips
        .iter()
        .map(|slip| draft_payslip(run_id, &run, &employer, slip))
        .collect::<Result<Vec<_>, HrError>>()?;
    store_drafts(db, run_id, at, kept, drafts).await?;

    let done = hr_pay_runs::Entity::update_many()
        .col_expr(hr_pay_runs::Column::Status, Expr::value("calculated"))
        .col_expr(hr_pay_runs::Column::CalculatedBy, Expr::value(user_id))
        .col_expr(hr_pay_runs::Column::CalculatedAt, Expr::value(at))
        .col_expr(
            hr_pay_runs::Column::Totals,
            Expr::value(aggregate_totals(&slips)),
        )
        .col_expr(
            hr_pay_runs::Column::Issues,
            Expr::value(Value::Array(sort_issues(issues))),
        )
        .col_expr(
            hr_pay_runs::Column::EmployeeCount,
            Expr::value(i32::try_from(slips.len()).unwrap_or_default()),
        )
        .col_expr(hr_pay_runs::Column::UpdatedAt, Expr::value(at))
        .filter(hr_pay_runs::Column::Id.eq(run_id))
        .filter(hr_pay_runs::Column::Status.eq("draft"))
        .exec(&orm(db))
        .await?;
    if done.rows_affected == 0 {
        hr_payslips::Entity::delete_many()
            .filter(hr_payslips::Column::RunId.eq(run_id))
            .filter(hr_payslips::Column::Status.eq("draft"))
            .exec(&orm(db))
            .await?;
        return Err(HrError::conflict(
            "This pay run was cancelled or changed while it was being calculated. Reload it and try again.",
        ));
    }
    require_run(db, run_id).await
}

/// `calculateCorrections(...)`: the difference against each original.
#[allow(clippy::too_many_arguments, clippy::too_many_lines)]
async fn calculate_corrections(
    db: &PgPool,
    run: &Value,
    employer: &Value,
    included: &[String],
    data: &[EmployeePayrollData],
    input_rows: &[Value],
    frequencies: &HashMap<String, String>,
    issues: &mut Vec<Value>,
    slips: &mut Vec<StoredPayslip>,
) -> Result<(), HrError> {
    let Some(corrects) = run["correctsRunId"].as_str().filter(|v| !v.is_empty()) else {
        return Err(HrError::conflict(
            "This correction run does not say which run it corrects",
        ));
    };
    let originals = payslip_rows(
        &orm(db),
        hr_payslips::Entity::find()
            .filter(hr_payslips::Column::RunId.eq(corrects))
            .filter(hr_payslips::Column::Status.eq("final")),
    )
    .await?;
    let all_corrections: Vec<Value> = if originals.is_empty() {
        vec![]
    } else {
        let ids: Vec<&str> = originals.iter().map(|o| s(o, "id")).collect();
        payslip_rows(
            &orm(db),
            hr_payslips::Entity::find()
                .filter(hr_payslips::Column::CorrectsPayslipId.is_in(ids))
                .filter(hr_payslips::Column::Status.eq("final")),
        )
        .await?
    };
    let headcount = run["includedEmployeeIds"]
        .as_array()
        .map_or(1.0, |a| a.len() as f64);
    for employee_id in included {
        let original = originals
            .iter()
            .rev()
            .find(|o| o["employeeId"] == employee_id.as_str());
        let d = data
            .iter()
            .find(|d| s(&d.employee, "id") == employee_id.as_str());
        let (Some(original), Some(d)) = (
            original,
            d.filter(|d| d.profile.is_some() && d.employer.is_some()),
        ) else {
            issues.push(employee_issue(
                "error",
                "employer_incomplete",
                employee_id,
                Some(json!({ "field": "payroll_profile" })),
            ));
            continue;
        };
        let readiness = readiness_issues(d, s(run, "periodEnd"), false, &[]);
        for issue in &readiness {
            push_issue(issues, issue.clone());
        }
        if has_missing_compensation(&readiness) {
            continue;
        }
        let original_year = int_of(original, "taxYear");
        let chain = final_payslips_by_employee(
            db,
            std::slice::from_ref(employee_id),
            s(employer, "id"),
            original_year,
        )
        .await?;
        let empty = vec![];
        let chain_rows = chain.get(employee_id).unwrap_or(&empty);
        let tip = latest_by_approval(chain_rows);

        let original_snapshot = snapshot_ytd(original);
        let original_input_ytd = original_snapshot.input.and_then(|i| i.ytd);
        let mut ytd_before = original_input_ytd.unwrap_or_default();
        for row in chain_rows {
            let corrected = row["correctsPayslipId"]
                .as_str()
                .filter(|v| !v.is_empty())
                .and_then(|id| chain_rows.iter().find(|x| x["id"] == id));
            let Some(corrected) = corrected else { continue };
            if s(corrected, "periodEnd") >= s(original, "periodEnd") {
                continue;
            }
            for (key, value) in snapshot_ytd(row).ytd_delta.unwrap_or_default().iter() {
                let current = ytd_before.get(key).copied().unwrap_or(0.0);
                ytd_before.insert(key.clone(), current + value);
            }
        }
        let original_input = &original["snapshot"]["input"];
        let nl_original = original_input["country"] == "NL";
        let built = build_payslip_input(BuildInputArgs {
            period: period_of(
                run,
                s(original, "payDate"),
                original_year,
                frequency_for(run, d, frequencies),
            ),
            employer,
            data: d,
            inputs: input_rows
                .iter()
                .filter(|r| r["employeeId"] == employee_id.as_str())
                .collect(),
            ytd: ytd_before.clone(),
            previous_year_annual_wage_cents: if nl_original {
                original_input["nl"]
                    .get("previousYearAnnualWageCents")
                    .cloned()
                    .unwrap_or(Value::Null)
            } else {
                Value::Null
            },
            holiday_allowance_opening_balance_cents: if nl_original {
                coalesce(&[original_input["nl"].get("holidayAllowanceOpeningBalanceCents")])
            } else {
                Value::Null
            },
            headcount,
        });
        let result = safe_calculate(&built, &ytd_before);
        let mut corrections: Vec<&Value> = all_corrections
            .iter()
            .filter(|c| c["correctsPayslipId"] == original["id"])
            .collect();
        corrections.sort_by(|a, b| {
            locale_compare(
                a["number"].as_str().unwrap_or(""),
                b["number"].as_str().unwrap_or(""),
            )
        });
        let diff = correction_from(
            &Recalculated {
                lines: &result.lines,
                totals: result.totals,
                ytd: &result.ytd,
                filing_data: &result.filing_data,
            },
            &ytd_before,
            &CorrectionBase {
                original,
                corrections,
            },
        );
        let mut ytd = match tip {
            Some(tip) => ytd_of(tip),
            None => ytd_of(original),
        };
        for (key, value) in diff.ytd_delta.iter() {
            let current = ytd.get(key).copied().unwrap_or(0.0);
            ytd.insert(key.clone(), current + value);
        }
        let mut employee_issues = as_issues(employee_id, &result.issues);
        merge_readiness(&mut employee_issues, &readiness);
        for issue in &employee_issues {
            push_issue(issues, issue.clone());
        }
        let mut input_json = built.json;
        input_json["ytd"] = weldsuite_payroll_domain::js::to_value(&ytd_before);
        slips.push(StoredPayslip {
            employee_id: employee_id.clone(),
            totals: diff.totals,
            tax_year: original_year,
            pay_date: s(run, "payDate").to_owned(),
            lines: diff.lines,
            ytd: weldsuite_payroll_domain::js::to_value(&ytd),
            filing_data: diff.filing_data,
            snapshot: json!({
                "kind": "correction",
                "dataVersion": "",
                "inputsStamp": "",
                "chain": { "tipId": tip.map(|t| t["id"].clone()), "previousYearTipId": null },
                "input": input_json,
                "ruleSet": result.rule_set,
                "ytdDelta": weldsuite_payroll_domain::js::to_value(&diff.ytd_delta),
                "originalNumber": original["number"],
                "recalculated": result.totals.to_json(),
            }),
            issues: sort_issues(employee_issues),
            corrects_payslip_id: Some(s(original, "id").to_owned()),
        });
    }
    Ok(())
}
