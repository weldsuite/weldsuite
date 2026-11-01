//! `BOOKS_INTERNAL`: books-api's `BooksInternal` entrypoint, the service
//! binding hr-api posts an approved pay run's journal over
//! (`POST /internal/payroll/imports`, `createBooksBridge` in
//! `services/weldhr/payroll/deps.ts`).
//!
//! The port is the binding itself: a request (path, the workspace key the
//! binding sends as `X-Workspace-Id`, a JSON body) and books-api's answer
//! (status and body). What the answer means (posted, a duplicate, reversed,
//! failed) is read in [`crate::payroll`], as the TypeScript bridge reads it,
//! so every implementation answers the way books-api's route does:
//!
//! - [`InProcessBooks`], the binary's: WeldBooks runs in the same process,
//!   so the import is `weldsuite-books-domain`'s `post_weldhr_import` on the
//!   workspace's own database, answered as the route would (status and
//!   JSON). The route publishes `payroll_import:created`; here the answer
//!   carries the event and hr publishes it, with the route's `system`
//!   source and user.
//! - in conformance builds, the test's own `BOOKS_INTERNAL` stub through the
//!   harness's service-binding bridge (`bins/weldsuite/src/conformance_books.rs`),
//!   and none when the test binds none (the journal is skipped with the
//!   worker's own message, as without the binding).

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use serde_json::{Value, json};
use weldsuite_books_domain::payroll::{
    WeldHrImport, WeldHrReply, WeldHrTotals, post_weldhr_import,
};
use weldsuite_db::PgPool;

/// One call over the binding.
#[derive(Debug, Clone, PartialEq)]
pub struct BooksRequest {
    /// `POST`.
    pub method: String,
    /// The path on books-api, `/internal/payroll/imports`.
    pub path: String,
    /// `X-Workspace-Id`: the workspace's R2 key (its Clerk org id), what
    /// books-api resolves the tenant by.
    pub workspace_key: String,
    /// The JSON body.
    pub body: Value,
}

/// books-api's answer.
#[derive(Debug, Clone, PartialEq)]
pub struct BooksResponse {
    pub status: u16,
    /// The body as books-api sent it (JSON, normally).
    pub body: String,
    /// The `payroll_import:created` event's data when the route would have
    /// published one and the caller has to ([`InProcessBooks`]).
    pub created_event: Option<Value>,
}

/// The `BOOKS_INTERNAL` binding. An `Err` is a call that never got an answer
/// (`binding.fetch` threw); its text is what the journal records. `db` is
/// the workspace's database, which an in-process implementation posts to.
pub trait BooksInternal: Send + Sync {
    fn call<'a>(
        &'a self,
        db: &'a PgPool,
        request: BooksRequest,
    ) -> Pin<Box<dyn Future<Output = Result<BooksResponse, String>> + Send + 'a>>;
}

/// A request's own binding (conformance: the test's stub), ahead of the
/// app's.
#[derive(Clone)]
pub struct RequestBooksInternal(pub Arc<dyn BooksInternal>);

impl std::fmt::Debug for RequestBooksInternal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("RequestBooksInternal")
    }
}

/// WeldBooks in the same process: the internal route's work on the
/// workspace's database.
#[derive(Debug, Default, Clone, Copy)]
pub struct InProcessBooks;

impl BooksInternal for InProcessBooks {
    fn call<'a>(
        &'a self,
        db: &'a PgPool,
        request: BooksRequest,
    ) -> Pin<Box<dyn Future<Output = Result<BooksResponse, String>> + Send + 'a>> {
        Box::pin(async move {
            if request.method != "POST" || request.path != "/internal/payroll/imports" {
                return Ok(answer(404, &error("NOT_FOUND", "Not Found")));
            }
            let Some(import) = import_of(&request.body) else {
                return Ok(answer(
                    400,
                    &error("BAD_REQUEST", "Invalid payroll payload"),
                ));
            };
            let entity_id = import.entity_id.clone();
            match post_weldhr_import(db, import, Some("system")).await {
                Ok(WeldHrReply::Created { body, event }) => Ok(BooksResponse {
                    created_event: Some(event),
                    ..answer(201, &json!({ "data": body }))
                }),
                Ok(WeldHrReply::Duplicate(body)) => Ok(answer(200, &json!({ "data": body }))),
                Ok(WeldHrReply::Reversed { message, details }) => Ok(answer(
                    409,
                    &json!({ "error": { "code": "CONFLICT", "message": message, "details": details } }),
                )),
                Ok(WeldHrReply::EntityNotFound) => Ok(answer(
                    404,
                    &error(
                        "NOT_FOUND",
                        &format!("Accounting entity with ID '{entity_id}' not found"),
                    ),
                )),
                Ok(WeldHrReply::BadRequest(message)) => {
                    Ok(answer(400, &error("BAD_REQUEST", &message)))
                }
                Err(failure) => {
                    tracing::error!(error = %failure, "hr: posting the payroll to WeldBooks failed");
                    Ok(answer(
                        500,
                        &error("INTERNAL_ERROR", "Failed to post the payroll"),
                    ))
                }
            }
        })
    }
}

fn answer(status: u16, body: &Value) -> BooksResponse {
    BooksResponse {
        status,
        body: body.to_string(),
        created_event: None,
    }
}

fn error(code: &str, message: &str) -> Value {
    json!({ "error": { "code": code, "message": message } })
}

/// `importSchema.safeParse(body)`: what hr-api sends, checked as the route
/// checks it; `None` is its 400.
fn import_of(body: &Value) -> Option<WeldHrImport> {
    let text = |key: &str, max: usize| -> Option<String> {
        let value = body.get(key)?.as_str()?;
        let len = value.encode_utf16().count();
        (1..=max).contains(&len).then(|| value.to_owned())
    };
    let iso = |value: &str| {
        let b = value.as_bytes();
        b.len() == 10
            && b[4] == b'-'
            && b[7] == b'-'
            && b.iter()
                .enumerate()
                .all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
    };
    let optional_date = |key: &str| -> Option<Option<String>> {
        match body.get(key) {
            None | Some(Value::Null) => Some(None),
            Some(Value::String(value)) if iso(value) => Some(Some(value.clone())),
            Some(_) => None,
        }
    };
    let totals = body.get("totals")?;
    let money = |key: &str| -> Option<f64> {
        let n = totals.get(key)?.as_f64()?;
        (n.is_finite() && (-1_000_000_000.0..=1_000_000_000.0).contains(&n)).then_some(n)
    };
    let pay_date = body.get("payDate")?.as_str().filter(|d| iso(d))?.to_owned();
    let us = match body.get("country")?.as_str()? {
        "US" => true,
        "NL" => false,
        _ => return None,
    };
    let posted_by = match body.get("postedBy") {
        None | Some(Value::Null) => None,
        Some(Value::String(value)) if value.encode_utf16().count() <= 255 => Some(value.clone()),
        Some(_) => return None,
    };
    let mapping = match body.get("mapping") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Object(map)) => map
            .iter()
            .map(|(k, v)| v.as_str().map(|id| (k.clone(), id.to_owned())))
            .collect::<Option<Vec<_>>>()?,
        Some(_) => return None,
    };
    Some(WeldHrImport {
        entity_id: text("entityId", 30)?,
        external_id: text("externalId", 100)?,
        pay_date,
        period_start: optional_date("periodStart")?,
        period_end: optional_date("periodEnd")?,
        description: text("description", 255)?,
        us,
        totals: WeldHrTotals {
            gross_wages: money("grossWages")?,
            employer_taxes: money("employerTaxes")?,
            employer_benefits: money("employerBenefits")?,
            reimbursements: money("reimbursements")?,
            employee_taxes: money("employeeTaxes")?,
            employee_deductions: money("employeeDeductions")?,
            net_pay: money("netPay")?,
        },
        mapping,
        posted_by,
    })
}
