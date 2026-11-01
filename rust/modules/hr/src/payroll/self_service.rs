//! The employee-facing payroll endpoints on My HR
//! (`routes/weldhr/payroll/self-service.ts`), for the signed-in member's own
//! employee; the employee id never comes from the request.

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use http::HeaderMap;
use serde_json::{Value, json};
use weldsuite_catalogs::entity_events::HR_EMPLOYEE_UPDATED;
use weldsuite_kit::{Created, Data};

use super::annual::{annual_statement_pdf, list_annual_statements};
use super::common::payslip_file_name;
use super::employees::{create_election, my_payroll_details, set_payment_details};
use super::notifier::notify_bank_change;
use super::payslips::{mark_payslip_viewed, my_payslips, payslip_pdf, require_payslip};
use super::schema::{json_body, str_of};
use super::{Deps, file_response, schemas};
use crate::me::self_employee_id;
use crate::{Caller, HrError, HrResult, HrState, query_param, query_values, today_iso};

pub(crate) fn routes() -> Router<HrState> {
    Router::new()
        .route("/payslips", get(payslips))
        .route("/payslips/{id}/pdf", get(payslip))
        .route("/annual-statements", get(annual_statements))
        .route("/annual-statements/{year}", get(annual_statement))
        .route("/payroll-details", get(details).put(update_details))
        .route("/tax-elections", post(sign_election))
}

async fn payslips(State(state): State<HrState>, caller: Caller) -> HrResult {
    let employee = self_employee_id(&state, &caller).await?;
    Ok(Data(Value::Array(my_payslips(&caller.db, &employee).await?)).into_response())
}

async fn payslip(State(state): State<HrState>, caller: Caller, Path(id): Path<String>) -> HrResult {
    let employee = self_employee_id(&state, &caller).await?;
    let row = require_payslip(&caller.db, &id, Some(&employee)).await?;
    let deps = Deps::of(&state, &caller);
    let bytes = payslip_pdf(&caller.db, &row, &deps).await?;
    mark_payslip_viewed(&caller.db, &id).await?;
    caller.audit("payroll.payslip_viewed", Some(&employee), json!({ "payslipId": row["id"] })).await?;
    let name = payslip_file_name(
        row["country"].as_str().unwrap_or(""),
        row["periodStart"].as_str().unwrap_or(""),
        row["payDate"].as_str().unwrap_or(""),
    );
    Ok(file_response(bytes, &name, "application/pdf"))
}

async fn annual_statements(State(state): State<HrState>, caller: Caller) -> HrResult {
    let employee = self_employee_id(&state, &caller).await?;
    Ok(Data(Value::Array(list_annual_statements(&caller.db, &employee).await?)).into_response())
}

/// `Number(param)` as an integer, `None` when it is not one.
pub(crate) fn integer_param(text: &str) -> Option<i64> {
    let n = weldsuite_kit::validation::js_number(text);
    (n.is_finite() && n.fract() == 0.0).then_some(n as i64)
}

async fn annual_statement(
    State(state): State<HrState>,
    caller: Caller,
    Path(year): Path<String>,
    RawQuery(raw): RawQuery,
) -> HrResult {
    let employee = self_employee_id(&state, &caller).await?;
    let Some(year) = integer_param(&year).filter(|y| (2000..=2100).contains(y)) else {
        return Err(HrError::validation("The year is not valid"));
    };
    let mut employer_id = query_param(&query_values(raw.as_deref()), "employerId").filter(|e| !e.is_empty());
    if employer_id.is_none() {
        let options: Vec<Value> = list_annual_statements(&caller.db, &employee)
            .await?
            .into_iter()
            .filter(|s| s["year"].as_i64() == Some(year))
            .collect();
        if options.is_empty() {
            return Err(HrError::not_found("Annual statement", &year.to_string()));
        }
        if options.len() > 1 {
            return Err(HrError::validation("Say which employer (employerId) the statement is for"));
        }
        employer_id = options[0]["employerId"].as_str().map(str::to_owned);
    }
    let employer_id = employer_id.unwrap_or_default();
    let deps = Deps::of(&state, &caller);
    let (bytes, file_name) = annual_statement_pdf(&caller.db, &employee, year, &employer_id, &deps).await?;
    caller
        .audit("payroll.annual_statement_viewed", Some(&employee), json!({ "year": year, "employerId": employer_id }))
        .await?;
    Ok(file_response(bytes, &file_name, "application/pdf"))
}

async fn details(State(state): State<HrState>, caller: Caller) -> HrResult {
    let employee = self_employee_id(&state, &caller).await?;
    Ok(Data(my_payroll_details(&caller.db, &employee, &caller.keyring(), &today_iso()).await?).into_response())
}

async fn update_details(State(state): State<HrState>, caller: Caller, headers: HeaderMap, body: Bytes) -> HrResult {
    let input = json_body(&headers, &body, &schemas::payment_details())?;
    let employee = self_employee_id(&state, &caller).await?;
    let keyring = caller.keyring();
    let result = set_payment_details(&caller.db, &employee, &input, &keyring, true).await?;
    if !result.changed_fields.is_empty() {
        let mut metadata = json!({ "fields": result.changed_fields, "by": "employee" });
        if result.id_verification_cleared {
            metadata["idVerificationCleared"] = json!(true);
        }
        caller.audit("payroll.payment_details_updated", Some(&employee), metadata).await?;
        if result.bank_changed {
            let bank: Vec<&String> = result.changed_fields.iter().filter(|f| f.starts_with("bank")).collect();
            caller.audit("payroll.bank_changed", Some(&employee), json!({ "fields": bank, "by": "employee" })).await?;
            notify_bank_change(&state, &caller, &employee, true);
        }
        caller.emit(&state, HR_EMPLOYEE_UPDATED, &employee, &[]);
    }
    Ok(Data(my_payroll_details(&caller.db, &employee, &keyring, &today_iso()).await?).into_response())
}

async fn sign_election(State(state): State<HrState>, caller: Caller, headers: HeaderMap, body: Bytes) -> HrResult {
    let input = json_body(&headers, &body, &schemas::create_election())?;
    let employee = self_employee_id(&state, &caller).await?;
    let today = today_iso();
    let limit = format!("{}-12-31", today.get(0..4).and_then(|y| y.parse::<i64>().ok()).unwrap_or(0) + 1);
    if str_of(&input, "effectiveFrom").is_some_and(|from| from > limit.as_str()) {
        return Err(HrError::validation("The effective date is too far ahead"));
    }
    let election = create_election(&caller.db, &employee, &input, &caller.user_id, "employee").await?;
    caller
        .audit(
            "payroll.tax_election_signed",
            Some(&employee),
            json!({ "kind": election["kind"], "state": election["state"], "electionId": election["id"], "by": "employee" }),
        )
        .await?;
    Ok(Created(my_payroll_details(&caller.db, &employee, &caller.keyring(), &today).await?).into_response())
}
