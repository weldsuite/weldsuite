//! Payroll setup routes (`routes/weldhr/payroll/setup.ts`): employers, pay
//! schedules, and everything per employee (profile, compensation,
//! components, tax elections, payment details).

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::response::IntoResponse;
use axum::routing::{delete, get, patch, post, put};
use http::HeaderMap;
use serde_json::{Value, json};
use weldsuite_catalogs::entity_events::HR_EMPLOYEE_UPDATED;
use weldsuite_catalogs::permission_keys::{PAYROLL_MANAGE, PAYROLL_PREPARE, PAYROLL_READ};
use weldsuite_kit::{Created, Data, NoContent};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use super::schema::{json_body, query, str_of};
use super::{employees as svc, employers, schemas};
use crate::{Caller, HrResult, HrState, today_iso};

pub(crate) fn routes<Q>(gate: &Arc<PermissionGate<Q>>) -> Router<HrState>
where
    Q: PermissionQueries + 'static,
{
    let read = || gate.require([PAYROLL_READ]);
    let prepare = || gate.require([PAYROLL_PREPARE]);
    let manage = || gate.require([PAYROLL_MANAGE]);
    Router::new()
        .route("/employers", get(list_employers).route_layer(read()))
        .route("/employers/{id}", get(get_employer).route_layer(read()))
        .route("/employers", post(create_employer).route_layer(manage()))
        .route("/employers/{id}", patch(update_employer).route_layer(manage()))
        .route("/employers/{id}", delete(delete_employer).route_layer(manage()))
        .route("/employers/{id}/bank", put(set_employer_bank).route_layer(manage()))
        .route("/schedules", get(list_schedules).route_layer(read()))
        .route("/schedules", post(create_schedule).route_layer(manage()))
        .route("/schedules/{id}", patch(update_schedule).route_layer(manage()))
        .route("/schedules/{id}", delete(delete_schedule).route_layer(manage()))
        .route("/employees", get(list_employees).route_layer(read()))
        .route("/employees/{id}", get(get_employee).route_layer(read()))
        .route("/employees/{id}/profile", put(upsert_profile).route_layer(prepare()))
        .route("/employees/{id}/payment-details", put(payment_details).route_layer(prepare()))
        .route("/employees/{id}/compensations", post(create_compensation).route_layer(prepare()))
        .route("/employees/{id}/components", post(create_component).route_layer(prepare()))
        .route("/employees/{id}/tax-elections", get(list_elections).route_layer(read()))
        .route("/employees/{id}/tax-elections", post(create_election).route_layer(prepare()))
        .route("/compensations/{id}", delete(delete_compensation).route_layer(prepare()))
        .route("/components/{id}", patch(update_component).route_layer(prepare()))
        .route("/components/{id}", delete(delete_component).route_layer(prepare()))
}

async fn list_employers(caller: Caller) -> HrResult {
    Ok(Data(employers::list_employers(&caller.db, &caller.keyring()).await?).into_response())
}

async fn get_employer(caller: Caller, Path(id): Path<String>) -> HrResult {
    Ok(Data(employers::get_employer(&caller.db, &id, &caller.keyring()).await?).into_response())
}

async fn create_employer(caller: Caller, headers: HeaderMap, body: Bytes) -> HrResult {
    let input = json_body(&headers, &body, &schemas::create_employer())?;
    let row = employers::create_employer(&caller.db, &input, &caller.user_id, &caller.keyring()).await?;
    Ok(Created(row).into_response())
}

async fn update_employer(caller: Caller, Path(id): Path<String>, headers: HeaderMap, body: Bytes) -> HrResult {
    let input = json_body(&headers, &body, &schemas::update_employer())?;
    Ok(Data(employers::update_employer(&caller.db, &id, &input, &caller.keyring()).await?).into_response())
}

async fn delete_employer(caller: Caller, Path(id): Path<String>) -> HrResult {
    employers::delete_employer(&caller.db, &id).await?;
    Ok(NoContent.into_response())
}

/// The salary account: write-only, masked on every read, every change
/// audited (names of fields only).
async fn set_employer_bank(caller: Caller, Path(id): Path<String>, headers: HeaderMap, body: Bytes) -> HrResult {
    let input = json_body(&headers, &body, &schemas::employer_bank())?;
    let (employer, changed) = employers::set_employer_bank(&caller.db, &id, &input, &caller.keyring()).await?;
    if !changed.is_empty() {
        caller
            .audit("payroll.employer_bank_updated", None, json!({ "employerId": employer["id"], "fields": changed }))
            .await?;
    }
    Ok(Data(employer).into_response())
}

async fn list_schedules(caller: Caller, RawQuery(raw): RawQuery) -> HrResult {
    let q = query(raw.as_deref(), &schemas::employer_query())?;
    Ok(Data(employers::list_schedules(&caller.db, str_of(&q, "employerId")).await?).into_response())
}

async fn create_schedule(caller: Caller, headers: HeaderMap, body: Bytes) -> HrResult {
    let input = json_body(&headers, &body, &schemas::create_schedule())?;
    Ok(Created(employers::create_schedule(&caller.db, &input).await?).into_response())
}

async fn update_schedule(caller: Caller, Path(id): Path<String>, headers: HeaderMap, body: Bytes) -> HrResult {
    let input = json_body(&headers, &body, &schemas::update_schedule())?;
    Ok(Data(employers::update_schedule(&caller.db, &id, &input).await?).into_response())
}

async fn delete_schedule(caller: Caller, Path(id): Path<String>) -> HrResult {
    employers::delete_schedule(&caller.db, &id).await?;
    Ok(NoContent.into_response())
}

async fn list_employees(caller: Caller, RawQuery(raw): RawQuery) -> HrResult {
    let q = query(raw.as_deref(), &schemas::employee_query())?;
    let on_payroll = str_of(&q, "onPayroll").map(|v| v == "true");
    let list =
        svc::list_payroll_employees(&caller.db, str_of(&q, "employerId"), on_payroll, &caller.keyring(), &today_iso())
            .await?;
    Ok(Data(Value::Array(list)).into_response())
}

async fn get_employee(caller: Caller, Path(id): Path<String>) -> HrResult {
    Ok(Data(svc::get_payroll_employee(&caller.db, &id, &caller.keyring(), &today_iso()).await?).into_response())
}

async fn upsert_profile(caller: Caller, Path(id): Path<String>, headers: HeaderMap, body: Bytes) -> HrResult {
    let input = json_body(&headers, &body, &schemas::upsert_profile())?;
    Ok(Data(svc::upsert_profile(&caller.db, &id, &input).await?).into_response())
}

async fn payment_details(
    State(state): State<HrState>,
    caller: Caller,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> HrResult {
    let input = json_body(&headers, &body, &schemas::payment_details())?;
    let result = svc::set_payment_details(&caller.db, &id, &input, &caller.keyring(), false).await?;
    if !result.changed_fields.is_empty() {
        caller
            .audit(
                "payroll.payment_details_updated",
                Some(&id),
                json!({ "fields": result.changed_fields, "by": "admin" }),
            )
            .await?;
        if result.bank_changed {
            let bank: Vec<&String> = result.changed_fields.iter().filter(|f| f.starts_with("bank")).collect();
            caller.audit("payroll.bank_changed", Some(&id), json!({ "fields": bank, "by": "admin" })).await?;
            super::notifier::notify_bank_change(&state, &caller, &id, false);
        }
        caller.emit(&state, HR_EMPLOYEE_UPDATED, &id, &[]);
    }
    Ok(Data(result.details).into_response())
}

async fn create_compensation(caller: Caller, Path(id): Path<String>, headers: HeaderMap, body: Bytes) -> HrResult {
    let input = json_body(&headers, &body, &schemas::create_compensation())?;
    Ok(Created(svc::create_compensation(&caller.db, &id, &input, &caller.user_id).await?).into_response())
}

async fn create_component(caller: Caller, Path(id): Path<String>, headers: HeaderMap, body: Bytes) -> HrResult {
    let input = json_body(&headers, &body, &schemas::create_component())?;
    Ok(Created(svc::create_component(&caller.db, &id, &input, &caller.user_id).await?).into_response())
}

async fn list_elections(caller: Caller, Path(id): Path<String>) -> HrResult {
    Ok(Data(Value::Array(svc::list_elections(&caller.db, &id).await?)).into_response())
}

/// HR enters a paper form: source `admin`, signed by the member who entered
/// it, in the signer's typed name.
async fn create_election(caller: Caller, Path(id): Path<String>, headers: HeaderMap, body: Bytes) -> HrResult {
    let input = json_body(&headers, &body, &schemas::create_election())?;
    let election = svc::create_election(&caller.db, &id, &input, &caller.user_id, "admin").await?;
    caller
        .audit(
            "payroll.tax_election_signed",
            Some(&id),
            json!({ "kind": election["kind"], "state": election["state"], "electionId": election["id"], "by": "admin" }),
        )
        .await?;
    Ok(Created(election).into_response())
}

async fn delete_compensation(caller: Caller, Path(id): Path<String>) -> HrResult {
    svc::delete_compensation(&caller.db, &id).await?;
    Ok(NoContent.into_response())
}

async fn update_component(caller: Caller, Path(id): Path<String>, headers: HeaderMap, body: Bytes) -> HrResult {
    let input = json_body(&headers, &body, &schemas::update_component())?;
    Ok(Data(svc::update_component(&caller.db, &id, &input).await?).into_response())
}

async fn delete_component(caller: Caller, Path(id): Path<String>) -> HrResult {
    svc::delete_component(&caller.db, &id).await?;
    Ok(NoContent.into_response())
}
