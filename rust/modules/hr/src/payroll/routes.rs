//! Pay run, payslip, filing and overview routes
//! (`routes/weldhr/payroll/{runs,documents,index}.ts`).
//!
//! Every run transition publishes an `hr_pay_run` event (ids and status
//! only); approval also publishes `hr_payslip` `published` per employee and
//! `hr_payroll_filing` per filing it touched.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::IntoResponse;
use axum::routing::{delete, get, patch, post};
use http::HeaderMap;
use serde_json::{Value, json};
use weldsuite_catalogs::entity_events::{
    HR_DECLARATION_PAID, HR_PAY_RUN_APPROVED, HR_PAY_RUN_CALCULATED, HR_PAY_RUN_CANCELLED, HR_PAY_RUN_CREATED,
    HR_PAY_RUN_PAID, HR_PAY_RUN_UPDATED, HR_PAYROLL_FILING_CREATED, HR_PAYROLL_FILING_UPDATED, HR_PAYSLIP_PUBLISHED,
};
use weldsuite_catalogs::permission_keys::{PAYROLL_APPROVE, PAYROLL_MANAGE, PAYROLL_PREPARE, PAYROLL_READ};
use weldsuite_kit::{Created, Data, NoContent};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use super::common::payslip_file_name;
use super::schema::{json_body, json_body_refined, query, str_of};
use super::{Deps, approve, calculate, file_response, files, filings, journal, overview, payslips, runs, schemas};
use crate::{Caller, HrResult, HrState, query_param, query_values, today_iso};

pub(crate) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<HrState>
where
    Q: PermissionQueries + 'static,
{
    let read = || gate.require([PAYROLL_READ]);
    let prepare = || gate.require([PAYROLL_PREPARE]);
    let approve = || gate.require([PAYROLL_APPROVE]);
    let manage = || gate.require([PAYROLL_MANAGE]);
    Router::new()
        .route("/overview", get(overview_route).route_layer(read()))
        .route("/runs", get(list_runs).route_layer(read()))
        .route("/runs/{id}", get(get_run).route_layer(read()))
        .route("/runs", post(create_run).route_layer(prepare()))
        .route("/runs/{id}", patch(update_run).route_layer(prepare()))
        .route("/runs/{id}/cancel", post(cancel_run).route_layer(prepare()))
        .route("/runs/{id}/employees", post(set_run_employee).route_layer(prepare()))
        .route("/runs/{id}/collect", post(collect).route_layer(prepare()))
        .route("/runs/{id}/inputs", get(list_inputs).route_layer(read()))
        .route("/runs/{id}/inputs", post(create_input).route_layer(prepare()))
        .route("/runs/{id}/inputs/{input_id}", patch(update_input).route_layer(prepare()))
        .route("/runs/{id}/inputs/{input_id}", delete(delete_input).route_layer(prepare()))
        .route("/runs/{id}/calculate", post(calculate_route).route_layer(prepare()))
        .route("/runs/{id}/approve", post(approve_route).route_layer(approve()))
        .route("/runs/{id}/mark-paid", post(mark_paid).route_layer(approve()))
        .route("/runs/{id}/post-journal", post(post_journal).route_layer(approve()))
        .route("/runs/{id}/payment-file", get(payment_file).route_layer(approve()))
        .route("/runs/{id}/report", get(report).route_layer(read()))
        .route("/payslips/{id}", get(get_payslip).route_layer(read()))
        .route("/payslips/{id}/pdf", get(payslip_pdf).route_layer(read()))
        .route("/filings", get(list_filings).route_layer(read()))
        .route("/filings/{id}", get(get_filing).route_layer(read()))
        .route("/filings/{id}/generate", post(generate_filing).route_layer(manage()))
        .route("/filings/{id}/file", get(filing_file).route_layer(manage()))
        .route("/filings/{id}/submit", post(submit_filing).route_layer(manage()))
        .route("/filings/{id}/refresh-status", post(refresh_filing).route_layer(manage()))
        .route("/filings/{id}/mark-filed", post(mark_filed).route_layer(manage()))
}

async fn overview_route(caller: Caller) -> HrResult {
    Ok(Data(overview::payroll_overview(&caller.db, &caller.keyring(), &today_iso()).await?).into_response())
}

async fn detail(caller: &Caller, id: &str) -> Result<Value, crate::HrError> {
    runs::get_run_detail(&caller.db, id, &caller.user_id).await
}

fn status_of(run: &Value) -> [(&'static str, Option<Value>); 1] {
    [("status", Some(run["status"].clone()))]
}

async fn list_runs(caller: Caller, RawQuery(raw): RawQuery) -> HrResult {
    let q = query(raw.as_deref(), &schemas::runs_query())?;
    let list = runs::list_runs(&caller.db, str_of(&q, "employerId"), str_of(&q, "status"), q["year"].as_f64()).await?;
    Ok(Data(Value::Array(list)).into_response())
}

async fn get_run(caller: Caller, Path(id): Path<String>) -> HrResult {
    Ok(Data(detail(&caller, &id).await?).into_response())
}

async fn create_run(State(state): State<HrState>, caller: Caller, headers: HeaderMap, body: Bytes) -> HrResult {
    let input = json_body_refined(&headers, &body, &schemas::create_run(), schemas::create_run_refine)?;
    let run = runs::create_run(&caller.db, &input, &caller.user_id).await?;
    let id = run["id"].as_str().unwrap_or("").to_owned();
    caller.emit(&state, HR_PAY_RUN_CREATED, &id, &status_of(&run));
    Ok(Created(detail(&caller, &id).await?).into_response())
}

async fn update_run(State(state): State<HrState>, caller: Caller, Path(id): Path<String>, headers: HeaderMap, body: Bytes) -> HrResult {
    let input = json_body(&headers, &body, &schemas::update_run())?;
    let run = runs::update_run(&caller.db, &id, &input).await?;
    caller.emit(&state, HR_PAY_RUN_UPDATED, &id, &status_of(&run));
    Ok(Data(detail(&caller, &id).await?).into_response())
}

async fn cancel_run(State(state): State<HrState>, caller: Caller, Path(id): Path<String>) -> HrResult {
    let run = runs::cancel_run(&caller.db, &id).await?;
    caller.emit(&state, HR_PAY_RUN_CANCELLED, &id, &status_of(&run));
    Ok(Data(detail(&caller, &id).await?).into_response())
}

async fn set_run_employee(
    State(state): State<HrState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> HrResult {
    let input = json_body(&headers, &body, &schemas::set_run_employee())?;
    let run = runs::set_run_employee(
        &caller.db,
        &id,
        str_of(&input, "employeeId").unwrap_or(""),
        input["excluded"].as_bool().unwrap_or(false),
    )
    .await?;
    caller.emit(&state, HR_PAY_RUN_UPDATED, &id, &status_of(&run));
    Ok(Data(detail(&caller, &id).await?).into_response())
}

async fn collect(State(state): State<HrState>, caller: Caller, Path(id): Path<String>) -> HrResult {
    runs::collect_run_inputs(&caller.db, &id, &caller.keyring(), &caller.user_id).await?;
    caller.emit(&state, HR_PAY_RUN_UPDATED, &id, &[]);
    Ok(Data(detail(&caller, &id).await?).into_response())
}

async fn list_inputs(caller: Caller, Path(id): Path<String>, RawQuery(raw): RawQuery) -> HrResult {
    let q = query(raw.as_deref(), &schemas::employee_query())?;
    Ok(Data(Value::Array(runs::list_run_inputs(&caller.db, &id, str_of(&q, "employeeId")).await?)).into_response())
}

async fn create_input(caller: Caller, Path(id): Path<String>, headers: HeaderMap, body: Bytes) -> HrResult {
    let input = json_body(&headers, &body, &schemas::create_run_input())?;
    Ok(Created(runs::create_run_input(&caller.db, &id, &input, &caller.user_id).await?).into_response())
}

async fn update_input(caller: Caller, Path((id, input_id)): Path<(String, String)>, headers: HeaderMap, body: Bytes) -> HrResult {
    let input = json_body(&headers, &body, &schemas::update_run_input())?;
    Ok(Data(runs::update_run_input(&caller.db, &id, &input_id, &input).await?).into_response())
}

async fn delete_input(caller: Caller, Path((id, input_id)): Path<(String, String)>) -> HrResult {
    runs::delete_run_input(&caller.db, &id, &input_id).await?;
    Ok(NoContent.into_response())
}

async fn calculate_route(State(state): State<HrState>, caller: Caller, Path(id): Path<String>) -> HrResult {
    let run = calculate::calculate_run(&caller.db, &id, &caller.keyring(), &caller.user_id).await?;
    caller.emit(&state, HR_PAY_RUN_CALCULATED, &id, &status_of(&run));
    Ok(Data(detail(&caller, &id).await?).into_response())
}

async fn approve_route(State(state): State<HrState>, caller: Caller, Path(id): Path<String>) -> HrResult {
    let deps = Deps::of(&state, &caller);
    let result = approve::approve_run(&state, &caller, &id, &deps).await?;
    caller
        .audit(
            "payroll.run_approved",
            None,
            json!({ "runId": result.run["id"], "payslips": result.payslips.len(), "journal": result.journal.status }),
        )
        .await?;
    caller.emit(&state, HR_PAY_RUN_APPROVED, &id, &status_of(&result.run));
    for (slip, employee, _) in &result.payslips {
        caller.emit(
            &state,
            HR_PAYSLIP_PUBLISHED,
            slip,
            &[("employeeId", Some(json!(employee))), ("status", Some(json!("final")))],
        );
    }
    for (filing, created) in &result.filings {
        let event = if *created { HR_PAYROLL_FILING_CREATED } else { HR_PAYROLL_FILING_UPDATED };
        caller.emit(&state, event, filing, &[("status", Some(json!("open")))]);
    }
    Ok(Data(detail(&caller, &id).await?).into_response())
}

async fn mark_paid(State(state): State<HrState>, caller: Caller, Path(id): Path<String>, headers: HeaderMap, body: Bytes) -> HrResult {
    let input = json_body(&headers, &body, &schemas::mark_paid())?;
    let (run, declarations) = approve::mark_run_paid(&caller.db, &id, &input, &caller.user_id).await?;
    caller.audit("payroll.run_paid", None, json!({ "runId": run["id"], "declarations": declarations.len() })).await?;
    caller.emit(&state, HR_PAY_RUN_PAID, &id, &status_of(&run));
    for declaration in &declarations {
        caller.emit(&state, HR_DECLARATION_PAID, declaration, &[("status", Some(json!("paid")))]);
    }
    Ok(Data(detail(&caller, &id).await?).into_response())
}

/// Retry the WeldBooks journal of an approved run (idempotent in books-api).
async fn post_journal(State(state): State<HrState>, caller: Caller, Path(id): Path<String>) -> HrResult {
    let deps = Deps::of(&state, &caller);
    journal::post_run_journal(&state, &caller.db, &id, &deps, Some(&caller.user_id)).await?;
    caller.emit(&state, HR_PAY_RUN_UPDATED, &id, &[]);
    Ok(Data(detail(&caller, &id).await?).into_response())
}

async fn payment_file(State(state): State<HrState>, caller: Caller, Path(id): Path<String>) -> HrResult {
    let deps = Deps::of(&state, &caller);
    let file = files::build_payment_file(&caller.db, &id, &deps).await?;
    let mut metadata = json!({ "runId": id, "fileName": file.file_name });
    if !file.warnings.is_empty() {
        metadata["warnings"] =
            Value::Array(file.warnings.iter().map(|w| json!({ "code": w["code"], "employeeId": w["employeeId"] })).collect());
    }
    caller.audit("payroll.payment_file_downloaded", None, metadata).await?;
    Ok(file_response(file.content.into_bytes(), &file.file_name, &file.content_type))
}

async fn report(caller: Caller, Path(id): Path<String>) -> HrResult {
    let (file_name, content_type, content) = files::build_run_report(&caller.db, &id).await?;
    Ok(file_response(content.into_bytes(), &file_name, &content_type))
}

async fn get_payslip(caller: Caller, Path(id): Path<String>) -> HrResult {
    Ok(Data(payslips::get_payslip(&caller.db, &id).await?).into_response())
}

/// A final payslip is the stored PDF; a draft is rendered on the fly with a
/// "draft" watermark.
async fn payslip_pdf(State(state): State<HrState>, caller: Caller, Path(id): Path<String>) -> HrResult {
    let row = payslips::require_payslip(&caller.db, &id, None).await?;
    let deps = Deps::of(&state, &caller);
    let bytes = payslips::payslip_pdf(&caller.db, &row, &deps).await?;
    let name = payslip_file_name(row["country"].as_str().unwrap_or(""), row["periodStart"].as_str().unwrap_or(""), row["payDate"].as_str().unwrap_or(""));
    Ok(file_response(bytes, &name, "application/pdf"))
}

async fn list_filings(caller: Caller, RawQuery(raw): RawQuery) -> HrResult {
    let q = query(raw.as_deref(), &schemas::filings_query())?;
    let list = filings::list_filings(&caller.db, str_of(&q, "employerId"), q["year"].as_f64(), str_of(&q, "status"), str_of(&q, "kind"))
        .await?;
    Ok(Data(Value::Array(list)).into_response())
}

async fn get_filing(caller: Caller, Path(id): Path<String>) -> HrResult {
    Ok(Data(filings::get_filing(&caller.db, &id).await?).into_response())
}

async fn generate_filing(State(state): State<HrState>, caller: Caller, Path(id): Path<String>) -> HrResult {
    let deps = Deps::of(&state, &caller);
    let row = filings::generate_filing(&caller.db, &id, &deps, &caller.user_id).await?;
    caller.emit(&state, HR_PAYROLL_FILING_UPDATED, &id, &status_of(&row));
    Ok(Data(filings::get_filing(&caller.db, &id).await?).into_response())
}

/// The generated file; `?name=` picks one of the extra files beside it. It
/// holds full BSN / SSN numbers: `payroll:manage`, and every download is
/// audited.
async fn filing_file(State(state): State<HrState>, caller: Caller, Path(id): Path<String>, RawQuery(raw): RawQuery) -> HrResult {
    let deps = Deps::of(&state, &caller);
    let name = query_param(&query_values(raw.as_deref()), "name");
    let (bytes, file_name, content_type) = filings::filing_file(&caller.db, &id, &deps, name.as_deref()).await?;
    caller.audit("payroll.filing_downloaded", None, json!({ "filingId": id, "fileName": file_name })).await?;
    Ok(file_response(bytes, &file_name, &content_type))
}

async fn submit_filing(caller: Caller, Path(id): Path<String>) -> HrResult {
    filings::submit_filing(&caller.db, &id).await?;
    Ok(NoContent.into_response())
}

async fn refresh_filing(caller: Caller, Path(id): Path<String>) -> HrResult {
    filings::refresh_filing_status(&caller.db, &id).await?;
    Ok(NoContent.into_response())
}

async fn mark_filed(State(state): State<HrState>, caller: Caller, Path(id): Path<String>, headers: HeaderMap, body: Bytes) -> HrResult {
    let input = json_body(&headers, &body, &schemas::mark_filed())?;
    let row = filings::mark_filing_filed(&caller.db, &id, &input, &caller.user_id).await?;
    caller
        .audit("payroll.filing_filed", None, json!({ "filingId": row["id"], "reference": row["externalReference"] }))
        .await?;
    caller.emit(&state, HR_PAYROLL_FILING_UPDATED, &id, &status_of(&row));
    Ok(Data(filings::get_filing(&caller.db, &id).await?).into_response())
}
