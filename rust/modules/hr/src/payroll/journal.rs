//! The WeldBooks journal of an approved pay run
//! (`services/weldhr/payroll/journal.ts`, `createBooksBridge` in `deps.ts`).
//!
//! Net pay is derived as gross − employee taxes − employee deductions, so
//! the entry balances by construction whatever the engine rounded. A
//! correction run has signed totals.

use serde_json::{Value, json};
use weldsuite_catalogs::entity_events::PAYROLL_IMPORT_CREATED;
use weldsuite_db::PgPool;
use weldsuite_events::{EntityEvent, EventContext, EventSource};

use super::Deps;
use super::payslips::employer_by_id;
use super::runs::{require_run, s};
use crate::{BooksRequest, HrError, HrState, now};

fn n(x: f64) -> Value {
    weldsuite_core_domain::js::number_value(x)
}

/// `journalTotalsFor(totals)`.
pub(crate) fn journal_totals_for(totals: &Value) -> Value {
    let c = |key: &str| totals[key].as_f64().unwrap_or(0.0);
    let gross = c("grossCents");
    let net_excluding_reimbursements = gross - c("employeeTaxesCents") - c("employeeDeductionsCents");
    let benefits = c("employerCostCents") - gross - c("employerTaxesCents") - c("reimbursementsCents");
    let engine_net = c("netCents") - c("reimbursementsCents");
    if engine_net != net_excluding_reimbursements {
        tracing::warn!(
            difference = engine_net - net_excluding_reimbursements,
            "[payroll] run net pay differs from gross minus taxes and deductions; the journal uses the derived figure"
        );
    }
    json!({
        "grossWages": n(gross / 100.0),
        "employerTaxes": n(c("employerTaxesCents") / 100.0),
        "employerBenefits": n(benefits / 100.0),
        "reimbursements": n(c("reimbursementsCents") / 100.0),
        "employeeTaxes": n(c("employeeTaxesCents") / 100.0),
        "employeeDeductions": n(c("employeeDeductionsCents") / 100.0),
        "netPay": n(net_excluding_reimbursements / 100.0),
    })
}

/// `JournalOutcome`.
pub(crate) struct JournalOutcome {
    pub(crate) status: &'static str,
    pub(crate) error: Option<String>,
    pub(crate) journal_entry_id: Option<String>,
}

impl JournalOutcome {
    pub(crate) fn to_json(&self) -> Value {
        json!({ "status": self.status, "error": self.error, "journalEntryId": self.journal_entry_id })
    }
}

fn failed(error: impl Into<String>) -> JournalOutcome {
    let error: String = error.into();
    let cut: String = String::from_utf16_lossy(&error.encode_utf16().take(500).collect::<Vec<u16>>());
    JournalOutcome { status: "failed", error: Some(cut), journal_entry_id: None }
}

/// `postPayroll` over `BOOKS_INTERNAL`, read as the TypeScript bridge reads
/// books-api's answer.
async fn post_payroll(state: &HrState, db: &PgPool, deps: &Deps, body: Value) -> JournalOutcome {
    let Some(books) = &deps.books else {
        return JournalOutcome {
            status: "skipped",
            error: Some("The WeldBooks link (BOOKS_INTERNAL) is not configured on this worker".into()),
            journal_entry_id: None,
        };
    };
    let request = BooksRequest {
        method: "POST".into(),
        path: "/internal/payroll/imports".into(),
        workspace_key: deps.workspace_key.clone(),
        body,
    };
    let response = match books.call(db, request).await {
        Ok(response) => response,
        Err(error) => return failed(error),
    };
    if let Some(event) = &response.created_event {
        // books-api's route publishes `payroll_import:created` as the system;
        // in-process, hr publishes it with the same context.
        let id = event["id"].as_str().unwrap_or("").to_owned();
        let context = EventContext::new(deps.workspace_key.clone(), "system", EventSource::System);
        state.events.publish(&context, EntityEvent::new(PAYROLL_IMPORT_CREATED, id, event.clone()));
    }
    let body: Option<Value> = serde_json::from_str(&response.body).ok();
    let data = body.as_ref().map(|b| &b["data"]);
    let import_id = data.and_then(|d| d["importId"].as_str()).filter(|v| !v.is_empty());
    let ok = (200..300).contains(&response.status);
    let Some(_import) = import_id.filter(|_| ok) else {
        let message = body
            .as_ref()
            .and_then(|b| b["error"]["message"].as_str())
            .map_or_else(|| format!("books-api answered {}", response.status), str::to_owned);
        return failed(message);
    };
    let data = data.cloned().unwrap_or(Value::Null);
    if data["status"] == "reversed" {
        return failed("This payroll was posted to WeldBooks and has since been reversed there.");
    }
    JournalOutcome { status: "posted", error: None, journal_entry_id: data["journalEntryId"].as_str().map(str::to_owned) }
}

/// `postRunJournal(db, runId, deps, { userId })`: post (or re-post, books-api
/// is idempotent per run) and record the outcome on the run.
pub(crate) async fn post_run_journal(
    state: &HrState,
    db: &PgPool,
    run_id: &str,
    deps: &Deps,
    user_id: Option<&str>,
) -> Result<JournalOutcome, HrError> {
    let run = require_run(db, run_id).await?;
    let status = s(&run, "status");
    if status != "approved" && status != "paid" {
        return Err(HrError::payroll(
            "RUN_NOT_APPROVED",
            format!("This pay run is {status}; the journal is posted once the run is approved"),
            409,
        ));
    }
    let Some(employer) = employer_by_id(db, s(&run, "employerId")).await? else {
        return Err(HrError::not_found("Payroll employer", s(&run, "employerId")));
    };
    let outcome = match employer["accountingEntityId"].as_str().filter(|v| !v.is_empty()) {
        None => JournalOutcome { status: "skipped", error: None, journal_entry_id: None },
        Some(_) if deps.books.is_none() => post_payroll(state, db, deps, Value::Null).await,
        Some(_) if run["totals"].is_null() => failed("The run has no totals to post"),
        Some(entity) => {
            let label = if run["kind"] == "correction" { "Payroll correction" } else { "Payroll" };
            let body = json!({
                "entityId": entity,
                "externalId": run["id"],
                "payDate": run["payDate"],
                "periodStart": run["periodStart"],
                "periodEnd": run["periodEnd"],
                "description": format!("{label} {} {} - {}", s(&employer, "name"), s(&run, "periodStart"), s(&run, "periodEnd")),
                "country": run["country"],
                "totals": journal_totals_for(&run["totals"]),
                "postedBy": user_id,
            });
            post_payroll(state, db, deps, body).await
        }
    };
    sqlx::query(
        "update hr_pay_runs set journal_status = $2, journal_entry_id = coalesce($3, journal_entry_id), journal_error = $4,
           updated_at = $5::timestamp where id = $1",
    )
    .bind(run_id)
    .bind(outcome.status)
    .bind(outcome.journal_entry_id.as_deref())
    .bind(outcome.error.as_deref())
    .bind(now())
    .execute(db)
    .await?;
    Ok(outcome)
}
