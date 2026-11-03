//! `/api/payment-runs` (`routes/payment-runs/*`): vendor payment runs, check
//! runs and ACH runs, with the bank account's payment settings, Positive
//! Pay, voiding checks and the check register.
//!
//! A run is planned (draft), submitted, approved (two people for ACH), and
//! only then does money move in the books: one payment per vendor that isn't
//! held, allocated over its bills. Backup withholding (24%) is taken out of
//! the payment: the bills settle for the gross, the bank is credited the net.
//!
//! Permissions: `bills:read` (view), `banking:create` (make, edit, submit,
//! cancel), `banking:manage` (approve, reject, release holds, print and
//! export files, void checks, settings), `banking:read` (settings, formats,
//! register).

mod approval;
mod checks;
mod holds;
mod nacha;
mod positive_pay;
mod runs;
mod settings;

use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post, put};
use http::{HeaderMap, StatusCode};
use serde_json::{Map, Value, json};
use sqlx::PgPool;
use weldsuite_books_domain::address::format_postal_address_lines;
use weldsuite_books_domain::bank_accounts::{BankAccountError, NO_KEY_MESSAGE};
use weldsuite_books_domain::dates::is_iso_date;
use weldsuite_books_domain::entity_context::resolve_entity_id;
use weldsuite_books_domain::guards::{AuditInput, GuardError, change, write_accounting_audit};
use weldsuite_books_domain::http::{
    BooksState, Caller, Refusal, all_rows, created, no_content, ok, paged, validate, validate_value,
};
use weldsuite_books_domain::js::math_round;
use weldsuite_books_domain::positive_pay::positive_pay_formats_json;
use weldsuite_books_domain::tables::BANK_ACCOUNTS;
use weldsuite_books_domain::vendor_tax::VendorTaxError;
use weldsuite_catalogs::entity_events::{
    BANK_ACCOUNT_UPDATED, PAYMENT_CREATED, PAYMENT_DELETED, PAYMENT_RUN_APPROVED,
    PAYMENT_RUN_CREATED, PAYMENT_RUN_DELETED, PAYMENT_RUN_EXPORTED, PAYMENT_RUN_UPDATED,
};
use weldsuite_kit::ApiError;
use weldsuite_kit::validation::{Field, Issues, Presence, Text};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use self::runs::{s, text};

// ── Errors ──────────────────────────────────────────────────────────────────

/// `PaymentRunError`: a problem the caller can act on.
#[derive(Debug)]
pub(crate) struct RunProblem {
    pub code: String,
    pub message: String,
    pub status: u16,
    pub details: Option<Value>,
}

/// How a payment-run route fails (`respondError`).
#[derive(Debug)]
pub(crate) enum RunError {
    /// `PaymentRunError`: `{ error: { code, message, details } }` with its status.
    Run(Box<RunProblem>),
    /// `ClosedPeriodError | LockedPeriodError | PostingError`: 400.
    BadRequest(String),
    /// `VendorTaxKeyError | AccountNumberKeyError`: 503.
    Unavailable(String),
    /// Anything else: the route's 500.
    Internal(String),
    /// A response the route writes before its `try` (validation).
    Refused(Refusal),
}

pub(crate) fn run_error(
    code: &str,
    message: String,
    status: u16,
    details: Option<Value>,
) -> RunError {
    RunError::Run(Box::new(RunProblem {
        code: code.to_owned(),
        message,
        status,
        details,
    }))
}

/// `badRequest(code, message, details)`.
pub(crate) fn bad(code: &str, message: &str, details: Option<Value>) -> RunError {
    run_error(code, message.to_owned(), 400, details)
}

/// `notFound(what, id)`.
pub(crate) fn not_found(what: &str, id: &str) -> RunError {
    run_error(
        "NOT_FOUND",
        format!("{what} with ID '{id}' not found"),
        404,
        None,
    )
}

impl From<sqlx::Error> for RunError {
    fn from(error: sqlx::Error) -> Self {
        Self::Internal(error.to_string())
    }
}

impl From<Refusal> for RunError {
    fn from(refusal: Refusal) -> Self {
        Self::Refused(refusal)
    }
}

impl From<GuardError> for RunError {
    fn from(error: GuardError) -> Self {
        match error {
            GuardError::Database(error) => Self::Internal(error.to_string()),
            other => Self::BadRequest(other.to_string()),
        }
    }
}

impl From<BankAccountError> for RunError {
    fn from(error: BankAccountError) -> Self {
        match error {
            BankAccountError::Posting(message) => Self::BadRequest(message),
            BankAccountError::NoKey => Self::Unavailable(NO_KEY_MESSAGE.to_owned()),
            other => Self::Internal(other.to_string()),
        }
    }
}

impl From<VendorTaxError> for RunError {
    fn from(error: VendorTaxError) -> Self {
        match error {
            VendorTaxError::NoKey => Self::Unavailable(error.to_string()),
            other => Self::Internal(other.to_string()),
        }
    }
}

impl RunError {
    fn respond(self, label: &str) -> Response {
        let fallback = format!("Failed to {label}");
        match self {
            Self::Run(problem) => {
                let mut error = Map::new();
                error.insert("code".to_owned(), json!(problem.code));
                error.insert("message".to_owned(), json!(problem.message));
                if let Some(details) = problem.details {
                    error.insert("details".to_owned(), details);
                }
                let status = StatusCode::from_u16(problem.status).unwrap_or(StatusCode::CONFLICT);
                (status, axum::Json(json!({ "error": error }))).into_response()
            }
            Self::BadRequest(message) => ApiError::bad_request(message).into_response(),
            Self::Unavailable(message) => ApiError::unavailable(message).into_response(),
            Self::Internal(error) => {
                tracing::error!(error, "[books-api/payment-runs] {label} failed");
                ApiError::internal().with_message(fallback).into_response()
            }
            Self::Refused(refusal) => refusal.respond(&fallback),
        }
    }
}

type Answer = Result<Response, RunError>;

fn answer(result: Answer, label: &str) -> Response {
    result.unwrap_or_else(|error| error.respond(label))
}

// ── Shared steps ────────────────────────────────────────────────────────────

/// `requireEntity(c, db)`: the request's accounting entity, or the 400.
async fn require_entity(caller: &Caller) -> Result<String, RunError> {
    resolve_entity_id(caller)
        .await?
        .ok_or_else(|| Refusal::bad_request("No accounting entity resolved").into())
}

/// `loadBankAccount(db, entityId, bankAccountId)`.
pub(crate) async fn load_bank_account(
    db: &PgPool,
    entity_id: &str,
    bank_account_id: &str,
) -> Result<Value, RunError> {
    let row: Option<Value> = sqlx::query_scalar(concat!(
        "select ",
        weldsuite_books_domain::books_row!(bank_accounts),
        " from bank_accounts t where t.id = $1 and t.entity_id = $2 and t.deleted_at is null limit 1"
    ))
    .bind(bank_account_id)
    .bind(entity_id)
    .fetch_optional(db)
    .await?;
    row.map(|row| BANK_ACCOUNTS.js(row))
        .ok_or_else(|| not_found("Bank account", bank_account_id))
}

/// `formatPostalAddressLines(address ? { country: 'US', ...address } : null, { omitCountry: 'US' })`.
pub(crate) fn us_address_lines(address: Option<&Value>) -> Vec<String> {
    let merged = address
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
    format_postal_address_lines(merged.as_ref(), Some("US"))
}

/// `runEventData(run)`: ids, status and totals only, never vendor bank data.
fn run_event_data(run: &Value) -> Value {
    let field = |key: &str| run.get(key).cloned().unwrap_or(Value::Null);
    json!({
        "id": field("id"),
        "method": field("method"),
        "status": field("status"),
        "bankAccountId": field("bankAccountId"),
        "paymentDate": field("paymentDate"),
        "totalAmount": field("totalAmount"),
        "paymentCount": field("paymentCount"),
        "requiredApprovals": field("requiredApprovals"),
    })
}

/// `auditRun(c, db, run, action, changes)`.
async fn audit_run(
    caller: &Caller,
    run: &Value,
    action: &str,
    changes: Option<Map<String, Value>>,
) {
    write_accounting_audit(
        caller,
        &caller.db,
        AuditInput {
            accounting_entity_id: text(run, "entityId"),
            entity_type: "payment_run",
            entity_id: s(run, "id"),
            action,
            changes,
        },
    )
    .await;
}

fn changes(entries: Vec<(&str, Value, Value)>) -> Map<String, Value> {
    entries
        .into_iter()
        .map(|(key, old, new)| (key.to_owned(), change(old, new)))
        .collect()
}

/// The entity event of a run mutation.
fn run_event(
    caller: &Caller,
    state: &BooksState,
    run: &Value,
    event: weldsuite_catalogs::entity_events::EventName,
) {
    caller.publish(state, event, s(run, "id"), run_event_data(run));
}

/// `{ id, amount, backupWithholdingAmount?, ... }` of a payment event.
fn payment_event_data(
    id: &str,
    amount: &Value,
    withheld: &Value,
    extra: &[(&str, Value)],
) -> Value {
    let mut data = Map::new();
    data.insert("id".to_owned(), json!(id));
    data.insert("amount".to_owned(), amount.clone());
    if weldsuite_books_domain::js::truthy(Some(withheld)) {
        data.insert("backupWithholdingAmount".to_owned(), withheld.clone());
    }
    for (key, value) in extra {
        data.insert((*key).to_owned(), value.clone());
    }
    Value::Object(data)
}

/// Failure injection for the conformance run of an approval that stops
/// partway: the worker's test mocks the payments service to throw after `n`
/// payments and hands Rust the same `n` in its env. The process env never
/// carries it (only the names in `BOOKS_ENV` reach books).
pub(crate) struct Faults {
    fail_after: Option<u32>,
    calls: AtomicU32,
}

/// The env key the conformance test sets.
const FAIL_PAYMENTS_AFTER: &str = "CONFORMANCE_FAIL_RECORD_PAYMENT_AFTER";

impl Faults {
    fn of(caller: &Caller, state: &BooksState) -> Self {
        Self {
            fail_after: caller
                .env(state, FAIL_PAYMENTS_AFTER)
                .and_then(|n| n.parse().ok()),
            calls: AtomicU32::new(0),
        }
    }

    /// A payment is about to be recorded.
    pub(crate) fn record_payment(&self) -> Result<(), RunError> {
        let Some(limit) = self.fail_after else {
            return Ok(());
        };
        if self.calls.fetch_add(1, Ordering::SeqCst) + 1 > limit {
            return Err(RunError::BadRequest(
                "Simulated failure while posting a payment".to_owned(),
            ));
        }
        Ok(())
    }
}

// ── Request schemas ─────────────────────────────────────────────────────────

/// `/^\d{4}-\d{2}-\d{2}$/`.
fn day_shape(value: &str) -> bool {
    let b = value.as_bytes();
    b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b.iter()
            .enumerate()
            .all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
}

/// `day` (`.regex(…, 'Use a YYYY-MM-DD date').refine(isIsoDate, 'Not a real
/// date')`): the refinement is settled after the body's synchronous checks.
fn read_day(
    issues: &mut Issues,
    body: &Map<String, Value>,
    key: &str,
    presence: Presence,
    pending: &mut Vec<Value>,
) -> Field<String> {
    let field = issues.pattern(
        body,
        key,
        presence,
        None,
        None,
        day_shape,
        "Use a YYYY-MM-DD date",
    );
    if let Some(Value::String(raw)) = body.get(key)
        && !is_iso_date(raw)
    {
        pending.push(
            json!({ "code": "custom", "message": "Not a real date", "path": issues.path_of(key) }),
        );
        return Field::Absent;
    }
    field
}

/// `amount`: `z.coerce.number().finite().positive().max(9_999_999_999)
/// .refine(twoDecimals, 'At most two decimals')`.
fn read_amount(
    issues: &mut Issues,
    body: &Map<String, Value>,
    pending: &mut Vec<Value>,
) -> Option<f64> {
    let n = weldsuite_kit::validation::js_number_of(body.get("amount"));
    if n.is_nan() {
        issues.issue_at(
            "amount",
            json!({ "code": "invalid_type", "expected": "number", "received": "nan", "message": "Expected number, received nan" }),
        );
        return None;
    }
    let before = issues.count();
    if !n.is_finite() {
        issues.issue_at(
            "amount",
            json!({ "code": "not_finite", "message": "Number must be finite" }),
        );
    }
    if n <= 0.0 {
        issues.issue_at(
            "amount",
            json!({ "code": "too_small", "minimum": 0, "type": "number", "inclusive": false, "exact": false, "message": "Number must be greater than 0" }),
        );
    }
    if n > 9_999_999_999.0 {
        issues.issue_at(
            "amount",
            json!({ "code": "too_big", "maximum": 9_999_999_999_i64, "type": "number", "inclusive": true, "exact": false, "message": "Number must be less than or equal to 9999999999" }),
        );
    }
    let cents = n * 100.0;
    let refined = (cents - math_round(cents)).abs() < 1e-6;
    if !refined {
        pending.push(json!({ "code": "custom", "message": "At most two decimals", "path": issues.path_of("amount") }));
    }
    (issues.count() == before && refined).then_some(n)
}

/// `z.union([z.literal(1), z.literal(2)])`.
#[allow(clippy::float_cmp)] // `z.literal(1)`: an exact match
fn read_required_approvals(issues: &mut Issues, body: &Map<String, Value>) -> Option<i64> {
    let value = body.get("requiredApprovals")?;
    if let Some(n) = value.as_f64()
        && (n == 1.0 || n == 2.0)
    {
        #[allow(clippy::cast_possible_truncation)]
        return Some(n as i64);
    }
    let path = issues.path_of("requiredApprovals");
    let literal = |expected: i64| {
        json!({
            "issues": [{
                "received": value,
                "code": "invalid_literal",
                "expected": expected,
                "path": path,
                "message": format!("Invalid literal value, expected {expected}"),
            }],
            "name": "ZodError",
        })
    };
    issues.issue_at(
        "requiredApprovals",
        json!({ "code": "invalid_union", "unionErrors": [literal(1), literal(2)], "message": "Invalid input" }),
    );
    None
}

/// `createRunSchema` (`method` and the required fields) or
/// `updateRunSchema` (`.omit({ method }).partial()`).
struct RunBody {
    bank_account_id: Option<String>,
    method: Option<String>,
    payment_date: Option<String>,
    sec_code: Field<String>,
    same_day: Option<bool>,
    items: Option<Vec<(String, f64)>>,
    required_approvals: Option<i64>,
    notes: Field<String>,
}

fn read_run_body(issues: &mut Issues, body: &Map<String, Value>, create: bool) -> RunBody {
    let mut pending: Vec<Value> = Vec::new();
    let required = if create {
        Presence::Required
    } else {
        Presence::Optional
    };
    let bank_account_id = issues
        .text(body, "bankAccountId", required, Some(1), Some(30))
        .into_option();
    let method = if create {
        issues
            .choice(body, "method", Presence::Required, &["check", "ach"])
            .into_option()
    } else {
        None
    };
    let payment_date = read_day(issues, body, "paymentDate", required, &mut pending).into_option();
    let sec_code = issues.choice(body, "secCode", Presence::Nullish, &settings::ACH_SEC_CODES);
    let same_day = issues
        .boolean(body, "sameDay", Presence::Optional)
        .into_option();
    let items = issues
        .list(
            body,
            "items",
            required,
            Some(1),
            Some(1000),
            |issues, item| {
                let fields = issues.object(item)?;
                let bill = issues.text(fields, "billId", Presence::Required, Some(1), Some(30));
                let amount = read_amount(issues, fields, &mut pending);
                Some((bill.into_option()?, amount?))
            },
        )
        .into_option();
    let required_approvals = read_required_approvals(issues, body);
    let notes = issues.text_with(
        body,
        "notes",
        Presence::Nullish,
        Text::trimmed(None, Some(2000)),
    );
    for issue in pending {
        issues.push_raw(issue);
    }
    RunBody {
        bank_account_id,
        method,
        payment_date,
        sec_code,
        same_day,
        items,
        required_approvals,
        notes,
    }
}

/// The query of a GET, validated (`zValidator('query', schema)`).
fn query_of<T>(
    caller: &Caller,
    read: impl FnOnce(&mut Issues, &Map<String, Value>) -> T,
) -> Result<T, RunError> {
    let values = Value::Object(caller.query().values().clone());
    Ok(validate_value(&values, read)?)
}

// ── Router ──────────────────────────────────────────────────────────────────

pub(crate) fn router<S, Q>(state: BooksState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        // Static paths first: they must not be read as a run id.
        .route(
            "/settings/{bank_account_id}",
            get(get_settings).route_layer(need("banking:read")),
        )
        .route(
            "/settings/{bank_account_id}",
            put(put_settings).route_layer(need("banking:manage")),
        )
        .route(
            "/positive-pay/formats",
            get(formats).route_layer(need("banking:read")),
        )
        .route(
            "/positive-pay",
            get(positive_pay_file).route_layer(need("banking:manage")),
        )
        .route(
            "/checks/{payment_id}/void",
            post(void_check).route_layer(need("banking:manage")),
        )
        .route(
            "/check-register",
            get(check_register).route_layer(need("banking:read")),
        )
        .route(
            "/payable-bills",
            get(payable_bills).route_layer(need("bills:read")),
        )
        .route("/", get(list).route_layer(need("bills:read")))
        .route("/", post(create).route_layer(need("banking:create")))
        .route("/{id}", get(detail).route_layer(need("bills:read")))
        .route("/{id}", patch(update).route_layer(need("banking:create")))
        .route("/{id}", delete(remove).route_layer(need("banking:create")))
        .route(
            "/{id}/submit",
            post(submit).route_layer(need("banking:create")),
        )
        .route(
            "/{id}/approve",
            post(approve).route_layer(need("banking:manage")),
        )
        .route(
            "/{id}/reject",
            post(reject).route_layer(need("banking:manage")),
        )
        .route(
            "/{id}/cancel",
            post(cancel).route_layer(need("banking:create")),
        )
        .route(
            "/{id}/release-hold",
            post(release_hold).route_layer(need("banking:manage")),
        )
        .route(
            "/{id}/checks",
            get(print_data).route_layer(need("banking:manage")),
        )
        .route(
            "/{id}/checks/printed",
            post(checks_printed).route_layer(need("banking:manage")),
        )
        .route(
            "/{id}/nacha",
            get(nacha_file).route_layer(need("banking:manage")),
        )
        .route(
            "/{id}/complete",
            post(complete).route_layer(need("banking:manage")),
        )
        .with_state(state)
}

// ── Settings ────────────────────────────────────────────────────────────────

async fn get_settings(caller: Caller, Path(bank_account_id): Path<String>) -> Response {
    let result: Answer = async {
        let entity_id = require_entity(&caller).await?;
        let bank = load_bank_account(&caller.db, &entity_id, &bank_account_id).await?;
        Ok(ok(settings::settings_view(&caller.db, &bank).await?))
    }
    .await;
    answer(result, "fetch payment settings")
}

async fn put_settings(
    caller: Caller,
    State(state): State<BooksState>,
    Path(bank_account_id): Path<String>,
    headers: HeaderMap,
    raw: Bytes,
) -> Response {
    let input = match validate(&headers, &raw, settings::read_settings_body) {
        Ok(input) => input,
        Err(refusal) => return refusal.respond(""),
    };
    let result: Answer = async {
        let entity_id = require_entity(&caller).await?;
        let (view, changed) =
            settings::update_bank_settings(&caller.db, &entity_id, &bank_account_id, input).await?;
        write_accounting_audit(
            &caller,
            &caller.db,
            AuditInput {
                accounting_entity_id: Some(&entity_id),
                entity_type: "bank_account",
                entity_id: &bank_account_id,
                action: "settings_updated",
                // Which sections changed, never their values.
                changes: Some(
                    changed
                        .iter()
                        .map(|key| ((*key).to_owned(), change(Value::Null, json!("changed"))))
                        .collect(),
                ),
            },
        )
        .await;
        caller.publish(
            &state,
            BANK_ACCOUNT_UPDATED,
            &bank_account_id,
            json!({
                "id": bank_account_id,
                "name": view.get("bankAccountName"),
                "nextCheckNumber": view.get("nextCheckNumber"),
                "changed": changed,
            }),
        );
        Ok(ok(view))
    }
    .await;
    answer(result, "update payment settings")
}

// ── Positive Pay ────────────────────────────────────────────────────────────

async fn formats() -> Response {
    let formats = positive_pay_formats_json();
    let rows = formats.as_array().cloned().unwrap_or_default();
    let total = i64::try_from(rows.len()).unwrap_or(0);
    paged(rows, total, false, None)
}

struct FileQuery {
    bank_account_id: String,
    from: Option<String>,
    to: Option<String>,
    format: Option<String>,
}

async fn positive_pay_file(caller: Caller, State(state): State<BooksState>) -> Response {
    let query = query_of(&caller, |issues, q| {
        let mut pending = Vec::new();
        let bank_account_id =
            issues.text(q, "bankAccountId", Presence::Required, Some(1), Some(30));
        let from = read_day(issues, q, "from", Presence::Optional, &mut pending);
        let to = read_day(issues, q, "to", Presence::Optional, &mut pending);
        let format = issues.text(q, "format", Presence::Optional, None, Some(30));
        for issue in pending {
            issues.push_raw(issue);
        }
        FileQuery {
            bank_account_id: bank_account_id.into_option().unwrap_or_default(),
            from: from.into_option(),
            to: to.into_option(),
            format: format.into_option(),
        }
    });
    let query = match query {
        Ok(query) => query,
        Err(error) => return error.respond("make Positive Pay file"),
    };
    let result: Answer = async {
        let entity_id = require_entity(&caller).await?;
        let file = positive_pay::generate_positive_pay(
            &caller.db,
            &caller.keyring(&state),
            &entity_id,
            &caller.user_id,
            &query.bank_account_id,
            query.from.as_deref(),
            query.to.as_deref(),
            query.format.as_deref(),
        )
        .await?;
        write_accounting_audit(
            &caller,
            &caller.db,
            AuditInput {
                accounting_entity_id: Some(&entity_id),
                entity_type: "bank_account",
                entity_id: &query.bank_account_id,
                action: "positive_pay",
                changes: Some(changes(vec![
                    ("fileName", Value::Null, file["fileName"].clone()),
                    ("records", Value::Null, file["counts"]["records"].clone()),
                ])),
            },
        )
        .await;
        Ok(ok(file))
    }
    .await;
    answer(result, "make Positive Pay file")
}

// ── Checks ──────────────────────────────────────────────────────────────────

struct VoidBody {
    reason: String,
    reissue: bool,
    date: Option<String>,
}

#[allow(clippy::too_many_lines)] // the worker's steps, in its order
async fn void_check(
    caller: Caller,
    State(state): State<BooksState>,
    Path(payment_id): Path<String>,
    headers: HeaderMap,
    raw: Bytes,
) -> Response {
    let body = match validate(&headers, &raw, |issues, body| {
        let mut pending = Vec::new();
        let reason = issues.text_with(
            body,
            "reason",
            Presence::Required,
            Text::trimmed(Some(3), Some(500)),
        );
        let reissue = issues.boolean(body, "reissue", Presence::Optional);
        let date = read_day(issues, body, "date", Presence::Optional, &mut pending);
        for issue in pending {
            issues.push_raw(issue);
        }
        VoidBody {
            reason: reason.into_option().unwrap_or_default(),
            reissue: reissue.into_option().unwrap_or(false),
            date: date.into_option(),
        }
    }) {
        Ok(body) => body,
        Err(refusal) => return refusal.respond(""),
    };
    let result: Answer = async {
        let entity_id = require_entity(&caller).await?;
        let faults = Faults::of(&caller, &state);
        let http = caller.http(&state);
        let result = checks::void_check(
            &caller.db,
            http.as_ref(),
            &faults,
            &entity_id,
            &payment_id,
            &caller.user_id,
            &body.reason,
            body.reissue,
            body.date.as_deref(),
        )
        .await?;
        let mut entries = vec![
            ("checkStatus", json!("printed"), json!("voided")),
            ("reason", Value::Null, json!(body.reason)),
        ];
        if let Some(replacement) = &result.replacement {
            entries.push(("replacedBy", Value::Null, replacement["paymentId"].clone()));
        }
        write_accounting_audit(
            &caller,
            &caller.db,
            AuditInput {
                accounting_entity_id: Some(&entity_id),
                entity_type: "payment",
                entity_id: &payment_id,
                action: "check_voided",
                changes: Some(changes(entries)),
            },
        )
        .await;
        caller.publish(
            &state,
            PAYMENT_DELETED,
            &payment_id,
            payment_event_data(
                &payment_id,
                &result.voided["amount"],
                &result.voided["backupWithholdingAmount"],
                &[("method", json!("check"))],
            ),
        );
        if let Some(replacement) = &result.replacement {
            let id = s(replacement, "paymentId");
            caller.publish(
                &state,
                PAYMENT_CREATED,
                id,
                payment_event_data(
                    id,
                    &replacement["amount"],
                    &replacement["backupWithholdingAmount"],
                    &[("method", json!("check"))],
                ),
            );
        }
        if let Some(run) = &result.run {
            audit_run(
                &caller,
                run,
                "check_voided",
                Some(changes(vec![(
                    "checkNumber",
                    result.voided["checkNumber"].clone(),
                    json!("voided"),
                )])),
            )
            .await;
            run_event(&caller, &state, run, PAYMENT_RUN_UPDATED);
        }
        Ok(ok(json!({
            "voided": result.voided,
            "replacement": result.replacement,
            "run": result.run,
        })))
    }
    .await;
    answer(result, "void check")
}

struct RegisterQuery {
    bank_account_id: Option<String>,
    from: Option<String>,
    to: Option<String>,
    status: Option<String>,
    limit: Option<String>,
    cursor: Option<String>,
}

async fn check_register(caller: Caller) -> Response {
    let query = query_of(&caller, |issues, q| {
        let mut pending = Vec::new();
        let bank_account_id =
            issues.text(q, "bankAccountId", Presence::Optional, Some(1), Some(30));
        let from = read_day(issues, q, "from", Presence::Optional, &mut pending);
        let to = read_day(issues, q, "to", Presence::Optional, &mut pending);
        let status = issues.choice(
            q,
            "status",
            Presence::Optional,
            &["to_print", "printed", "cleared", "voided"],
        );
        let limit = issues.text(q, "limit", Presence::Optional, None, None);
        let cursor = issues.text(q, "cursor", Presence::Optional, None, None);
        for issue in pending {
            issues.push_raw(issue);
        }
        RegisterQuery {
            bank_account_id: bank_account_id.into_option(),
            from: from.into_option(),
            to: to.into_option(),
            status: status.into_option(),
            limit: limit.into_option(),
            cursor: cursor.into_option(),
        }
    });
    let query = match query {
        Ok(query) => query,
        Err(error) => return error.respond("fetch check register"),
    };
    let result: Answer = async {
        let Some(entity_id) = resolve_entity_id(&caller).await? else {
            return Ok(paged(Vec::new(), 0, false, None));
        };
        let (rows, summary, total, has_more, cursor) = checks::check_register(
            &caller.db,
            &entity_id,
            checks::Register {
                bank_account_id: query.bank_account_id.as_deref(),
                from: query.from.as_deref(),
                to: query.to.as_deref(),
                status: query.status.as_deref(),
                limit: runs::page_limit(query.limit.as_deref(), 100, 500),
                cursor: query.cursor.as_deref(),
            },
        )
        .await?;
        Ok(axum::Json(json!({
            "data": rows,
            "summary": summary,
            "pagination": { "totalCount": total, "hasMore": has_more, "cursor": cursor },
        }))
        .into_response())
    }
    .await;
    answer(result, "fetch check register")
}

// ── Runs ────────────────────────────────────────────────────────────────────

struct PayableQuery {
    due_before: Option<String>,
    party_id: Option<String>,
    bank_account_id: Option<String>,
}

async fn payable_bills(caller: Caller) -> Response {
    let query = query_of(&caller, |issues, q| {
        let mut pending = Vec::new();
        let due_before = read_day(issues, q, "dueBefore", Presence::Optional, &mut pending);
        let party_id = issues.text(q, "partyId", Presence::Optional, Some(1), Some(30));
        let bank_account_id =
            issues.text(q, "bankAccountId", Presence::Optional, Some(1), Some(30));
        for issue in pending {
            issues.push_raw(issue);
        }
        PayableQuery {
            due_before: due_before.into_option(),
            party_id: party_id.into_option(),
            bank_account_id: bank_account_id.into_option(),
        }
    });
    let query = match query {
        Ok(query) => query,
        Err(error) => return error.respond("fetch payable bills"),
    };
    let result: Answer = async {
        let entity_id = require_entity(&caller).await?;
        let vendors = runs::list_payable_bills(
            &caller.db,
            &entity_id,
            query.due_before.as_deref(),
            query.party_id.as_deref(),
            query.bank_account_id.as_deref(),
        )
        .await?;
        Ok(all_rows(vendors))
    }
    .await;
    answer(result, "fetch payable bills")
}

async fn list(caller: Caller) -> Response {
    let result: Answer = async {
        let q = caller.query();
        let Some(entity_id) = resolve_entity_id(&caller).await? else {
            // An empty tenant simply has nothing to list.
            return Ok(paged(Vec::new(), 0, false, None));
        };
        let (rows, total, has_more, cursor) = runs::list_runs(
            &caller.db,
            &entity_id,
            runs::ListRuns {
                status: q.present("status"),
                method: q.present("method"),
                bank_account_id: q.present("bankAccountId"),
                limit: runs::page_limit(q.get("limit"), 25, 100),
                cursor: q.present("cursor"),
            },
        )
        .await?;
        Ok(paged(rows, total, has_more, cursor))
    }
    .await;
    answer(result, "fetch payment runs")
}

async fn create(
    caller: Caller,
    State(state): State<BooksState>,
    headers: HeaderMap,
    raw: Bytes,
) -> Response {
    let body = match validate(&headers, &raw, |issues, body| {
        read_run_body(issues, body, true)
    }) {
        Ok(body) => body,
        Err(refusal) => return refusal.respond(""),
    };
    let result: Answer = async {
        let entity_id = require_entity(&caller).await?;
        let (run, lowered) = runs::create_run(
            &caller.db,
            &entity_id,
            runs::CreateRun {
                user_id: caller.user_id.clone(),
                bank_account_id: body.bank_account_id.clone().unwrap_or_default(),
                ach: body.method.as_deref() == Some("ach"),
                payment_date: body.payment_date.clone().unwrap_or_default(),
                sec_code: body.sec_code.clone().into_option(),
                same_day: body.same_day.unwrap_or(false),
                items: body.items.clone().unwrap_or_default(),
                required_approvals: body.required_approvals,
                notes: body.notes.clone().into_option(),
                can_lower_approvals: caller.can("banking:manage"),
            },
        )
        .await?;
        let field = |key: &str| run.get(key).cloned().unwrap_or(Value::Null);
        let mut entries = vec![
            ("method", Value::Null, field("method")),
            ("totalAmount", Value::Null, field("totalAmount")),
            ("requiredApprovals", Value::Null, field("requiredApprovals")),
        ];
        if lowered {
            entries.push(("approvalsLowered", json!(false), json!(true)));
        }
        audit_run(&caller, &run, "created", Some(changes(entries))).await;
        run_event(&caller, &state, &run, PAYMENT_RUN_CREATED);
        Ok(created(
            runs::get_run_detail(&caller.db, &entity_id, s(&run, "id")).await?,
        ))
    }
    .await;
    answer(result, "create payment run")
}

async fn detail(caller: Caller, Path(id): Path<String>) -> Response {
    let result: Answer = async {
        let entity_id = require_entity(&caller).await?;
        Ok(ok(runs::get_run_detail(&caller.db, &entity_id, &id).await?))
    }
    .await;
    answer(result, "fetch payment run")
}

async fn update(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    raw: Bytes,
) -> Response {
    let body = match validate(&headers, &raw, |issues, body| {
        read_run_body(issues, body, false)
    }) {
        Ok(body) => body,
        Err(refusal) => return refusal.respond(""),
    };
    let result: Answer = async {
        let entity_id = require_entity(&caller).await?;
        let (run, before) = runs::update_run(
            &caller.db,
            &entity_id,
            &id,
            runs::UpdateRun {
                payment_date: body.payment_date,
                sec_code: body.sec_code,
                same_day: body.same_day,
                items: body.items,
                required_approvals: body.required_approvals,
                notes: body.notes,
                bank_account_id: body.bank_account_id,
                can_lower_approvals: caller.can("banking:manage"),
            },
        )
        .await?;
        let pair = |key: &str| {
            (
                before.get(key).cloned().unwrap_or(Value::Null),
                run.get(key).cloned().unwrap_or(Value::Null),
            )
        };
        let (old_total, new_total) = pair("totalAmount");
        let (old_approvals, new_approvals) = pair("requiredApprovals");
        let (old_date, new_date) = pair("paymentDate");
        audit_run(
            &caller,
            &run,
            "updated",
            Some(changes(vec![
                ("totalAmount", old_total, new_total),
                ("requiredApprovals", old_approvals, new_approvals),
                ("paymentDate", old_date, new_date),
            ])),
        )
        .await;
        run_event(&caller, &state, &run, PAYMENT_RUN_UPDATED);
        Ok(ok(runs::get_run_detail(
            &caller.db,
            &entity_id,
            s(&run, "id"),
        )
        .await?))
    }
    .await;
    answer(result, "update payment run")
}

async fn remove(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
) -> Response {
    let result: Answer = async {
        let entity_id = require_entity(&caller).await?;
        let run = runs::delete_run(&caller.db, &entity_id, &id).await?;
        audit_run(&caller, &run, "deleted", None).await;
        run_event(&caller, &state, &run, PAYMENT_RUN_DELETED);
        Ok(no_content())
    }
    .await;
    answer(result, "delete payment run")
}

async fn submit(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
) -> Response {
    let result: Answer = async {
        let entity_id = require_entity(&caller).await?;
        let run = runs::submit_run(&caller.db, &entity_id, &id).await?;
        audit_run(
            &caller,
            &run,
            "submitted",
            Some(changes(vec![(
                "status",
                json!("draft"),
                run["status"].clone(),
            )])),
        )
        .await;
        run_event(&caller, &state, &run, PAYMENT_RUN_UPDATED);
        Ok(ok(runs::get_run_detail(
            &caller.db,
            &entity_id,
            s(&run, "id"),
        )
        .await?))
    }
    .await;
    answer(result, "submit payment run")
}

async fn approve(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
) -> Response {
    let result: Answer = async {
        let entity_id = require_entity(&caller).await?;
        let faults = Faults::of(&caller, &state);
        let http = caller.http(&state);
        let result = approval::approve_run(
            &caller.db,
            http.as_ref(),
            &faults,
            &entity_id,
            &id,
            &caller.user_id,
        )
        .await?;
        let count = i64::try_from(result.approval_count).unwrap_or(0);
        let mut entries = vec![("approvals", json!(count - 1), json!(count))];
        if result.approved {
            entries.push((
                "status",
                json!("pending_approval"),
                result.run["status"].clone(),
            ));
        }
        audit_run(&caller, &result.run, "approved", Some(changes(entries))).await;
        run_event(
            &caller,
            &state,
            &result.run,
            if result.approved {
                PAYMENT_RUN_APPROVED
            } else {
                PAYMENT_RUN_UPDATED
            },
        );
        for payment in &result.payments {
            if payment["created"] != json!(true) {
                continue;
            }
            let id = s(payment, "paymentId");
            caller.publish(
                &state,
                PAYMENT_CREATED,
                id,
                payment_event_data(
                    id,
                    &payment["amount"],
                    &payment["backupWithholdingAmount"],
                    &[
                        ("date", result.run["paymentDate"].clone()),
                        ("method", result.run["method"].clone()),
                    ],
                ),
            );
        }
        let run = runs::get_run_detail(&caller.db, &entity_id, s(&result.run, "id")).await?;
        Ok(ok(json!({
            "run": run,
            "approved": result.approved,
            "approvalCount": result.approval_count,
            "requiredApprovals": result.run.get("requiredApprovals"),
            "payments": result.payments,
        })))
    }
    .await;
    answer(result, "approve payment run")
}

async fn reject(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    raw: Bytes,
) -> Response {
    let reason = match validate(&headers, &raw, |issues, body| {
        issues
            .text_with(
                body,
                "reason",
                Presence::Required,
                Text::trimmed(Some(3), Some(500)),
            )
            .into_option()
            .unwrap_or_default()
    }) {
        Ok(reason) => reason,
        Err(refusal) => return refusal.respond(""),
    };
    let result: Answer = async {
        let entity_id = require_entity(&caller).await?;
        let run = runs::reject_run(&caller.db, &entity_id, &id).await?;
        audit_run(
            &caller,
            &run,
            "rejected",
            Some(changes(vec![
                ("reason", Value::Null, json!(reason)),
                ("status", json!("pending_approval"), run["status"].clone()),
            ])),
        )
        .await;
        run_event(&caller, &state, &run, PAYMENT_RUN_UPDATED);
        Ok(ok(runs::get_run_detail(
            &caller.db,
            &entity_id,
            s(&run, "id"),
        )
        .await?))
    }
    .await;
    answer(result, "reject payment run")
}

async fn cancel(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
) -> Response {
    let result: Answer = async {
        let entity_id = require_entity(&caller).await?;
        let run = runs::cancel_run(&caller.db, &entity_id, &id).await?;
        audit_run(
            &caller,
            &run,
            "cancelled",
            Some(changes(vec![("status", Value::Null, json!("cancelled"))])),
        )
        .await;
        run_event(&caller, &state, &run, PAYMENT_RUN_UPDATED);
        Ok(ok(runs::get_run_detail(
            &caller.db,
            &entity_id,
            s(&run, "id"),
        )
        .await?))
    }
    .await;
    answer(result, "cancel payment run")
}

async fn release_hold(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    raw: Bytes,
) -> Response {
    let body = match validate(&headers, &raw, |issues, body| {
        let party_id = issues.text(body, "partyId", Presence::Required, Some(1), Some(30));
        let reason = issues.text_with(
            body,
            "reason",
            Presence::Optional,
            Text::trimmed(None, Some(500)),
        );
        (
            party_id.into_option().unwrap_or_default(),
            reason.into_option(),
        )
    }) {
        Ok(body) => body,
        Err(refusal) => return refusal.respond(""),
    };
    let (party_id, reason) = body;
    let result: Answer = async {
        let entity_id = require_entity(&caller).await?;
        let (run, released) = runs::release_hold(
            &caller.db,
            &entity_id,
            &id,
            &party_id,
            &caller.user_id,
            reason.as_deref(),
        )
        .await?;
        let mut entries = vec![
            ("partyId", json!(party_id), json!(party_id)),
            (
                "holds",
                json!(released.iter().map(|h| h.code.clone()).collect::<Vec<_>>()),
                json!("released"),
            ),
        ];
        if let Some(reason) = reason.as_deref().filter(|r| !r.is_empty()) {
            entries.push(("reason", Value::Null, json!(reason)));
        }
        audit_run(&caller, &run, "hold_released", Some(changes(entries))).await;
        run_event(&caller, &state, &run, PAYMENT_RUN_UPDATED);
        Ok(ok(runs::get_run_detail(
            &caller.db,
            &entity_id,
            s(&run, "id"),
        )
        .await?))
    }
    .await;
    answer(result, "release hold")
}

async fn print_data(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
) -> Response {
    let result: Answer = async {
        let entity_id = require_entity(&caller).await?;
        let include_printed = caller.query().get("all") == Some("true");
        Ok(ok(checks::build_check_print_data(
            &caller.db,
            &caller.keyring(&state),
            &entity_id,
            &id,
            &caller.user_id,
            include_printed,
        )
        .await?))
    }
    .await;
    answer(result, "build check print data")
}

async fn checks_printed(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    raw: Bytes,
) -> Response {
    let payment_ids = match validate(&headers, &raw, |issues, body| {
        issues
            .list(
                body,
                "paymentIds",
                Presence::Required,
                Some(1),
                Some(500),
                |issues, item| issues.item_text(item, Text::length(Some(1), Some(30))),
            )
            .into_option()
            .unwrap_or_default()
    }) {
        Ok(ids) => ids,
        Err(refusal) => return refusal.respond(""),
    };
    let result: Answer = async {
        let entity_id = require_entity(&caller).await?;
        let (run, printed, already) =
            checks::mark_checks_printed(&caller.db, &entity_id, &id, &payment_ids).await?;
        audit_run(
            &caller,
            &run,
            "checks_printed",
            Some(changes(vec![("printed", json!(0), json!(printed.len()))])),
        )
        .await;
        run_event(&caller, &state, &run, PAYMENT_RUN_UPDATED);
        let detail = runs::get_run_detail(&caller.db, &entity_id, s(&run, "id")).await?;
        Ok(ok(
            json!({ "run": detail, "printed": printed, "alreadyPrinted": already }),
        ))
    }
    .await;
    answer(result, "mark checks printed")
}

async fn nacha_file(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
) -> Response {
    let result: Answer = async {
        let entity_id = require_entity(&caller).await?;
        let file = nacha::generate_nacha_file(
            &caller.db,
            &caller.keyring(&state),
            &entity_id,
            &id,
            &caller.user_id,
        )
        .await?;
        audit_run(
            &caller,
            &file.run,
            "exported",
            Some(changes(vec![
                ("fileName", Value::Null, json!(file.file_name)),
                (
                    "totalCredit",
                    Value::Null,
                    file.summary["totalCredit"].clone(),
                ),
            ])),
        )
        .await;
        run_event(&caller, &state, &file.run, PAYMENT_RUN_EXPORTED);
        Ok(ok(
            json!({ "fileName": file.file_name, "content": file.content, "summary": file.summary }),
        ))
    }
    .await;
    answer(result, "make NACHA file")
}

async fn complete(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
) -> Response {
    let result: Answer = async {
        let entity_id = require_entity(&caller).await?;
        let run = nacha::complete_ach_run(&caller.db, &entity_id, &id).await?;
        audit_run(
            &caller,
            &run,
            "completed",
            Some(changes(vec![(
                "status",
                json!("exported"),
                json!("completed"),
            )])),
        )
        .await;
        run_event(&caller, &state, &run, PAYMENT_RUN_UPDATED);
        Ok(ok(runs::get_run_detail(
            &caller.db,
            &entity_id,
            s(&run, "id"),
        )
        .await?))
    }
    .await;
    answer(result, "complete payment run")
}
