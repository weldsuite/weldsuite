//! `/api/form-1099` (`routes/form-1099/{index,filings}.ts`): 1099 reporting.
//!
//!   GET  /summary, /vendors/:partyId, /deadlines, /945   the yearly review
//!   GET  /tin-matching/file, POST /tin-matching/results  IRS TIN Matching
//!   /filings/...                                          filings, lines, IRIS file, copies
//!
//! The year is the calendar year the payments were made in (cash basis).
//! Permissions: `taxes:read|create|update|delete|file`, and `tax_ids:reveal`
//! where full TINs leave. Entity events never carry recipients or TINs.

mod data;
mod filings;
mod outputs;

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use http::{HeaderMap, HeaderValue, StatusCode};
use serde_json::{Map, Value, json};
use weldsuite_books_domain::entity_context::resolve_entity_id;
use weldsuite_books_domain::form_1099::{
    EFILE_THRESHOLD, FORM_8508_LEAD_DAYS, form_1099_deadlines, form_8508_deadline,
};
use weldsuite_books_domain::guards::{AuditInput, change, write_accounting_audit};
use weldsuite_books_domain::http::{
    BooksState, Caller, Refusal, all_rows, created, no_content, ok, validate,
};
use weldsuite_catalogs::entity_events::{
    ACCOUNTING_CONTACT_UPDATED, FORM_1099_FILING_CREATED, FORM_1099_FILING_DELETED,
    FORM_1099_FILING_FILED, FORM_1099_FILING_GENERATED, FORM_1099_FILING_UPDATED,
};
use weldsuite_kit::ApiError;
use weldsuite_kit::validation::{Field, Issues, Number, Presence, Text, js_number};
use weldsuite_permissions::{PermissionGate, PermissionQueries};

use filings::LinePatch;

/// `Form1099Error` (by kind), `VendorTaxKeyError`, or a failure.
#[derive(Debug)]
pub(crate) enum Fail {
    BadRequest(String, Option<Value>),
    NotFound(String),
    Conflict(String, Option<Value>),
    Unavailable(String),
    Database(sqlx::Error),
    Internal(String),
}

impl Fail {
    pub(crate) fn bad(message: impl Into<String>) -> Self {
        Self::BadRequest(message.into(), None)
    }

    pub(crate) fn conflict(message: impl Into<String>) -> Self {
        Self::Conflict(message.into(), None)
    }

    pub(crate) fn not_found(message: impl Into<String>) -> Self {
        Self::NotFound(message.into())
    }

    /// `respondError(c, err, what)`.
    fn respond(self, what: &str) -> Response {
        let with = |error: ApiError, details: Option<Value>| match details {
            Some(details) => error.with_details(details).into_response(),
            None => error.into_response(),
        };
        match self {
            Self::BadRequest(message, details) => with(ApiError::bad_request(message), details),
            Self::NotFound(message) => {
                ApiError::new(StatusCode::NOT_FOUND, "NOT_FOUND", message).into_response()
            }
            Self::Conflict(message, details) => with(ApiError::conflict(message), details),
            Self::Unavailable(message) => ApiError::unavailable(message).into_response(),
            Self::Database(error) => Refusal::Database(error).respond(&format!("Failed to {what}")),
            Self::Internal(error) => Refusal::Internal(error).respond(&format!("Failed to {what}")),
        }
    }
}

impl From<sqlx::Error> for Fail {
    fn from(error: sqlx::Error) -> Self {
        Self::Database(error)
    }
}

fn finish(result: Result<Response, Fail>, what: &str) -> Response {
    result.unwrap_or_else(|fail| fail.respond(what))
}

pub(crate) fn router<S, Q>(state: BooksState, gate: &Arc<PermissionGate<Q>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Q: PermissionQueries + 'static,
{
    let need = |key: &str| gate.require([key.to_owned()]);
    Router::new()
        .route("/summary", get(summary).route_layer(need("taxes:read")))
        .route(
            "/vendors/{party_id}",
            get(vendor).route_layer(need("taxes:read")),
        )
        .route("/deadlines", get(deadlines).route_layer(need("taxes:read")))
        .route("/945", get(form_945).route_layer(need("taxes:read")))
        .route(
            "/tin-matching/file",
            get(tin_matching_file)
                .route_layer(need("tax_ids:reveal"))
                .route_layer(need("taxes:file")),
        )
        .route(
            "/tin-matching/results",
            post(tin_matching_results).route_layer(need("taxes:file")),
        )
        .route(
            "/filings",
            get(list_filings).route_layer(need("taxes:read")),
        )
        .route(
            "/filings",
            post(create_filing).route_layer(need("taxes:create")),
        )
        .route(
            "/filings/{id}",
            get(filing_detail).route_layer(need("taxes:read")),
        )
        .route(
            "/filings/{id}",
            patch(update_filing).route_layer(need("taxes:update")),
        )
        .route(
            "/filings/{id}",
            axum::routing::delete(delete_filing).route_layer(need("taxes:delete")),
        )
        .route(
            "/filings/{id}/refresh",
            post(refresh).route_layer(need("taxes:update")),
        )
        .route(
            "/filings/{id}/lines/{line_id}",
            patch(update_line).route_layer(need("taxes:update")),
        )
        .route(
            "/filings/{id}/review",
            post(review).route_layer(need("taxes:update")),
        )
        .route(
            "/filings/{id}/generate",
            post(generate).route_layer(need("taxes:file")),
        )
        .route(
            "/filings/{id}/iris-csv",
            get(iris_get)
                .post(iris_post)
                .route_layer(need("tax_ids:reveal"))
                .route_layer(need("taxes:file")),
        )
        .route(
            "/filings/{id}/lines/{line_id}/copies",
            get(copies).route_layer(need("taxes:read")),
        )
        .route(
            "/filings/{id}/mark-filed",
            post(mark_filed).route_layer(need("taxes:file")),
        )
        .route(
            "/filings/{id}/lines/{line_id}/correct",
            post(correct).route_layer(need("taxes:file")),
        )
        .route(
            "/filings/{id}/lines/{line_id}/delivered",
            post(delivered).route_layer(need("taxes:update")),
        )
        .with_state(state)
}

/// `parseYear(c)`: last year until March, then this year; else the asked one.
#[allow(clippy::cast_possible_truncation)]
fn parse_year(caller: &Caller) -> Result<i64, Fail> {
    let now = weldsuite_books_domain::js::iso_from_millis(caller.now_ms()).unwrap_or_default();
    let current: i64 = now.get(0..4).and_then(|y| y.parse().ok()).unwrap_or(1970);
    let month: i64 = now.get(5..7).and_then(|m| m.parse().ok()).unwrap_or(1);
    let q = caller.query();
    let raw = q.get("year").unwrap_or_default();
    if raw.is_empty() {
        return Ok(if month <= 3 { current - 1 } else { current });
    }
    let year = js_number(raw);
    if year.fract() != 0.0 || !year.is_finite() || year < 2020.0 || year > (current + 1) as f64 {
        return Err(Fail::bad(
            "year must be a tax year from 2020 up to next year",
        ));
    }
    Ok(year as i64)
}

async fn entity_or_400(caller: &Caller) -> Result<String, Fail> {
    resolve_entity_id(caller)
        .await?
        .ok_or_else(|| Fail::bad("No accounting entity resolved"))
}

fn no_store(mut response: Response) -> Response {
    response.headers_mut().insert(
        http::header::CACHE_CONTROL,
        HeaderValue::from_static("no-store"),
    );
    response
}

async fn audit(
    caller: &Caller,
    entity_id: Option<&str>,
    entity_type: &str,
    target: &str,
    action: &str,
    changes: Option<Map<String, Value>>,
) {
    write_accounting_audit(
        caller,
        &caller.db,
        AuditInput {
            accounting_entity_id: entity_id,
            entity_type,
            entity_id: target,
            action,
            changes,
        },
    )
    .await;
}

fn changes(pairs: &[(&str, Value, Value)]) -> Map<String, Value> {
    pairs
        .iter()
        .map(|(k, old, new)| ((*k).to_owned(), change(old.clone(), new.clone())))
        .collect()
}

// ---------------------------------------------------------------------------
// The yearly review

async fn summary(caller: Caller) -> Response {
    let result = async {
        let year = parse_year(&caller)?;
        let entity_id = entity_or_400(&caller).await?;
        let (loaded, result) =
            data::compute_for_entity(&caller.db, &entity_id, year, None, Vec::new()).await?;
        Ok(ok(data::build_summary(&loaded, &result)))
    }
    .await;
    finish(result, "compute the 1099 summary")
}

async fn vendor(caller: Caller, Path(party_id): Path<String>) -> Response {
    let result = async {
        let year = parse_year(&caller)?;
        let entity_id = entity_or_400(&caller).await?;
        match data::vendor_drill_down(&caller.db, &entity_id, year, &party_id).await? {
            Some(detail) => Ok(ok(detail)),
            None => Ok(ApiError::not_found("Vendor", Some(&party_id)).into_response()),
        }
    }
    .await;
    finish(result, "fetch the vendor 1099 detail")
}

async fn deadlines(caller: Caller) -> Response {
    let year = match parse_year(&caller) {
        Ok(year) => year,
        Err(fail) => return fail.respond("fetch the deadlines"),
    };
    let mut deadlines = form_1099_deadlines(year);
    let nec_irs = deadlines["nec"]["irs"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let misc_paper = deadlines["misc"]["irsPaper"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    deadlines["eFile"] = json!({
        "requiredFrom": EFILE_THRESHOLD,
        "waiverRequestDays": FORM_8508_LEAD_DAYS,
        "necWaiverDeadline": form_8508_deadline(&nec_irs),
        "miscWaiverDeadline": form_8508_deadline(&misc_paper),
    });
    ok(deadlines)
}

async fn form_945(caller: Caller) -> Response {
    let result = async {
        let year = parse_year(&caller)?;
        let entity_id = entity_or_400(&caller).await?;
        Ok(ok(data::backup_withholding_for_945(
            &caller.db, &entity_id, year,
        )
        .await?))
    }
    .await;
    finish(result, "compute the Form 945 summary")
}

// ---------------------------------------------------------------------------
// TIN matching

async fn tin_matching_file(caller: Caller, State(state): State<BooksState>) -> Response {
    let result = async {
        let entity_id = resolve_entity_id(&caller).await?;
        let q = caller.query();
        let party_ids = q.get("partyIds").map(|raw| {
            raw.split(',')
                .map(|id| weldsuite_kit::validation::js_trim(id).to_owned())
                .filter(|id| !id.is_empty())
                .collect::<Vec<_>>()
        });
        let result = outputs::build_tin_matching(
            &caller.db,
            &caller.keyring(&state),
            entity_id.as_deref(),
            &caller.user_id,
            q.get("all") == Some("true"),
            party_ids,
        )
        .await?;
        audit(
            &caller,
            entity_id.as_deref(),
            "tin_matching",
            entity_id.as_deref().unwrap_or("workspace"),
            "file_created",
            Some(changes(&[(
                "records",
                Value::Null,
                result["recordCount"].clone(),
            )])),
        )
        .await;
        Ok(no_store(ok(result)))
    }
    .await;
    finish(result, "create the TIN matching file")
}

fn read_results(issues: &mut Issues, body: &Map<String, Value>) -> String {
    issues
        .text(body, "text", Presence::Required, Some(1), Some(5_000_000))
        .into_option()
        .unwrap_or_default()
}

async fn tin_matching_results(
    caller: Caller,
    State(state): State<BooksState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let text = match validate(&headers, &body, read_results) {
        Ok(text) => text,
        Err(refusal) => return refusal.respond("Failed to apply the TIN matching results"),
    };
    let result = async {
        let (updated, result) = outputs::apply_tin_matching_results(&caller.db, &text).await?;
        for party_id in &updated {
            caller.publish(
                &state,
                ACCOUNTING_CONTACT_UPDATED,
                party_id,
                json!({ "id": party_id, "tinMatchChecked": true }),
            );
        }
        audit(
            &caller,
            None,
            "tin_matching",
            "workspace",
            "results_applied",
            Some(changes(&[("updated", Value::Null, json!(updated.len()))])),
        )
        .await;
        Ok(ok(result))
    }
    .await;
    finish(result, "apply the TIN matching results")
}

// ---------------------------------------------------------------------------
// Filings

fn event_data(detail: &Value, extra: &[(&str, Value)]) -> Value {
    filings::filing_event_data(&detail["filing"], extra)
}

fn with(detail: Value, extra: &[(&str, Value)]) -> Value {
    let mut detail = detail;
    for (key, value) in extra {
        detail[*key] = value.clone();
    }
    detail
}

async fn list_filings(caller: Caller) -> Response {
    let result = async {
        let Some(entity_id) = resolve_entity_id(&caller).await? else {
            return Ok(all_rows(Vec::new()));
        };
        let q = caller.query();
        let year = q
            .present("year")
            .and_then(weldsuite_books_domain::js::parse_int)
            .filter(|y| *y != 0);
        let form = q.get("formType").filter(|f| matches!(*f, "nec" | "misc"));
        let rows =
            filings::list_filings(&caller.db, &entity_id, year, form, q.present("status")).await?;
        Ok(all_rows(rows))
    }
    .await;
    finish(result, "fetch 1099 filings")
}

#[allow(clippy::cast_precision_loss)]
fn read_create(issues: &mut Issues, body: &Map<String, Value>, max_year: i64) -> (i64, String) {
    let year = issues.number(
        body,
        "taxYear",
        Presence::Required,
        Number {
            int: true,
            min: Some(2020.0),
            max: Some(max_year as f64),
            ..Number::default()
        },
    );
    let form = issues.choice(body, "formType", Presence::Required, &["nec", "misc"]);
    #[allow(clippy::cast_possible_truncation)]
    (
        year.into_option().map_or(0, |y| y as i64),
        form.into_option().unwrap_or_default(),
    )
}

async fn create_filing(
    caller: Caller,
    State(state): State<BooksState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let now = weldsuite_books_domain::js::iso_from_millis(weldsuite_books_domain::http::now_ms())
        .unwrap_or_default();
    let max_year = now
        .get(0..4)
        .and_then(|y| y.parse::<i64>().ok())
        .unwrap_or(2026)
        + 1;
    let (tax_year, form) = match validate(&headers, &body, |i, b| read_create(i, b, max_year)) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond("Failed to create the 1099 filing"),
    };
    let result = async {
        let entity_id = entity_or_400(&caller).await?;
        let (filing_id, line_count, warnings) =
            filings::create_filing(&caller.db, &entity_id, tax_year, &form, &caller.user_id)
                .await?;
        let detail = filings::load_filing_detail(&caller.db, &entity_id, &filing_id).await?;
        audit(
            &caller,
            Some(&entity_id),
            "form_1099_filing",
            &filing_id,
            "created",
            None,
        )
        .await;
        caller.publish(
            &state,
            FORM_1099_FILING_CREATED,
            &filing_id,
            event_data(&detail, &[("lineCount", json!(line_count))]),
        );
        Ok(created(with(detail, &[("warnings", json!(warnings))])))
    }
    .await;
    finish(result, "create the 1099 filing")
}

async fn filing_detail(caller: Caller, Path(id): Path<String>) -> Response {
    let result = async {
        let entity_id = entity_or_400(&caller).await?;
        Ok(ok(
            filings::load_filing_detail(&caller.db, &entity_id, &id).await?
        ))
    }
    .await;
    finish(result, "fetch the 1099 filing")
}

fn read_notes(issues: &mut Issues, body: &Map<String, Value>) -> Option<String> {
    issues
        .text(body, "notes", Presence::Nullable, None, Some(5000))
        .into_option()
}

async fn update_filing(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let notes = match validate(&headers, &body, read_notes) {
        Ok(notes) => notes,
        Err(refusal) => return refusal.respond("Failed to update the 1099 filing"),
    };
    let result = async {
        let entity_id = entity_or_400(&caller).await?;
        let before = filings::load_filing_detail(&caller.db, &entity_id, &id).await?;
        sqlx::query(
            "update form_1099_filings set notes = $1, updated_at = $2::timestamp where id = $3",
        )
        .bind(&notes)
        .bind(weldsuite_books_domain::http::now())
        .bind(&id)
        .execute(&caller.db)
        .await?;
        let detail = filings::load_filing_detail(&caller.db, &entity_id, &id).await?;
        audit(
            &caller,
            Some(&entity_id),
            "form_1099_filing",
            &id,
            "updated",
            Some(changes(&[(
                "notes",
                before["filing"]["notes"].clone(),
                json!(notes),
            )])),
        )
        .await;
        caller.publish(
            &state,
            FORM_1099_FILING_UPDATED,
            &id,
            event_data(&detail, &[]),
        );
        Ok(ok(detail))
    }
    .await;
    finish(result, "update the 1099 filing")
}

async fn delete_filing(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
) -> Response {
    let result = async {
        let entity_id = entity_or_400(&caller).await?;
        let filing = filings::delete_filing(&caller.db, &entity_id, &id).await?;
        audit(
            &caller,
            Some(&entity_id),
            "form_1099_filing",
            &id,
            "deleted",
            None,
        )
        .await;
        caller.publish(
            &state,
            FORM_1099_FILING_DELETED,
            &id,
            filings::filing_event_data(&filing, &[]),
        );
        Ok(no_content())
    }
    .await;
    finish(result, "delete the 1099 filing")
}

async fn refresh(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
) -> Response {
    let result = async {
        let entity_id = entity_or_400(&caller).await?;
        let refreshed = filings::refresh_filing(&caller.db, &entity_id, &id).await?;
        let detail = filings::load_filing_detail(&caller.db, &entity_id, &id).await?;
        audit(
            &caller,
            Some(&entity_id),
            "form_1099_filing",
            &id,
            "refreshed",
            None,
        )
        .await;
        caller.publish(
            &state,
            FORM_1099_FILING_UPDATED,
            &id,
            event_data(
                &detail,
                &[
                    ("refreshed", json!(true)),
                    ("added", refreshed["added"].clone()),
                ],
            ),
        );
        Ok(ok(with(detail, &[("refresh", refreshed)])))
    }
    .await;
    finish(result, "refresh the 1099 filing")
}

fn is_box_code(code: &str) -> bool {
    let (form, number) = match code.split_once('_') {
        Some(parts) => parts,
        None => return false,
    };
    matches!(form, "nec" | "misc")
        && (1..=2).contains(&number.len())
        && number.bytes().all(|b| b.is_ascii_digit())
}

/// `z.record(boxCode, z.number().finite().min(0))`.
fn read_boxes(
    issues: &mut Issues,
    body: &Map<String, Value>,
    presence: Presence,
) -> Option<Vec<(String, f64)>> {
    issues
        .nested(body, "boxes", presence, |i, map| {
            let mut out = Vec::new();
            for key in map.keys() {
                if !is_box_code(key) {
                    let path = i.path_of(key);
                    i.push_raw(json!({ "validation": "regex", "code": "invalid_string", "message": "Invalid", "path": path }));
                }
                let value = i.number(map, key, Presence::Required, Number { min: Some(0.0), ..Number::default() });
                if let Field::Set(value) = value {
                    out.push((key.clone(), value));
                }
            }
            out
        })
        .into_option()
}

/// `linePatchSchema`; the keys given, in the schema's order.
fn read_line_patch(
    issues: &mut Issues,
    body: &Map<String, Value>,
) -> (LinePatch, Vec<&'static str>) {
    let mut refinements: Vec<Value> = Vec::new();
    let adjustments = issues
        .list(body, "adjustments", Presence::Optional, None, Some(50), |i, item| {
            let fields = i.object(item)?;
            let code = i.pattern(fields, "box", Presence::Required, None, None, is_box_code, "Invalid");
            let amount = i.number(fields, "amount", Presence::Required, Number::default());
            #[allow(clippy::float_cmp)] // `n !== 0`
            if amount == Field::Set(0.0) {
                refinements.push(json!({ "code": "custom", "message": "Not zero", "path": i.path_of("amount") }));
            }
            let reason = i.text_with(fields, "reason", Presence::Required, Text::trimmed(Some(1), Some(255)));
            Some((code.into_option()?, amount.into_option()?, reason.into_option()?))
        })
        .into_option();
    let status = issues.choice(
        body,
        "status",
        Presence::Optional,
        &["included", "excluded"],
    );
    let excluded_reason = issues.text_with(
        body,
        "excludedReason",
        Presence::Nullish,
        Text::trimmed(None, Some(255)),
    );
    let state_code = issues.text_with(
        body,
        "stateCode",
        Presence::Nullish,
        Text::trimmed(None, None),
    );
    if let Field::Set(code) = &state_code {
        issues.string_length("stateCode", 2, code.encode_utf16().count());
    }
    let state_id = issues.text_with(
        body,
        "stateIdNumber",
        Presence::Nullish,
        Text::trimmed(None, Some(50)),
    );
    let non_negative = Number {
        min: Some(0.0),
        ..Number::default()
    };
    let state_income = issues.number(body, "stateIncome", Presence::Nullish, non_negative);
    let state_withheld = issues.number(body, "stateWithheld", Presence::Nullish, non_negative);
    let boxes = read_boxes(issues, body, Presence::Optional);
    for issue in refinements {
        issues.push_raw(issue);
    }
    let nullable = |field: Field<String>| match field {
        Field::Absent => None,
        Field::Null => Some(None),
        Field::Set(v) => Some(Some(v)),
    };
    let nullable_number = |field: Field<f64>| match field {
        Field::Absent => None,
        Field::Null => Some(None),
        Field::Set(v) => Some(Some(v)),
    };
    let mut keys = Vec::new();
    for (key, present) in [
        ("adjustments", adjustments.is_some()),
        ("status", !status.is_absent()),
        ("excludedReason", !excluded_reason.is_absent()),
        ("stateCode", !state_code.is_absent()),
        ("stateIdNumber", !state_id.is_absent()),
        ("stateIncome", !state_income.is_absent()),
        ("stateWithheld", !state_withheld.is_absent()),
        ("boxes", boxes.is_some()),
    ] {
        if present {
            keys.push(key);
        }
    }
    (
        LinePatch {
            adjustments,
            status: status.into_option(),
            excluded_reason: nullable(excluded_reason),
            state_code: nullable(state_code),
            state_id_number: nullable(state_id),
            state_income: nullable_number(state_income),
            state_withheld: nullable_number(state_withheld),
            boxes,
        },
        keys,
    )
}

async fn update_line(
    caller: Caller,
    State(state): State<BooksState>,
    Path((id, line_id)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let (patch, keys) = match validate(&headers, &body, read_line_patch) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond("Failed to update the filing line"),
    };
    let result = async {
        let entity_id = entity_or_400(&caller).await?;
        let detail = filings::update_line(
            &caller.db,
            &entity_id,
            &id,
            &line_id,
            &patch,
            &caller.user_id,
        )
        .await?;
        audit(
            &caller,
            Some(&entity_id),
            "form_1099_filing",
            &id,
            "line_updated",
            Some(changes(&[(&line_id, Value::Null, json!(keys.join(",")))])),
        )
        .await;
        caller.publish(
            &state,
            FORM_1099_FILING_UPDATED,
            &id,
            event_data(&detail, &[("lineUpdated", json!(line_id))]),
        );
        Ok(ok(detail))
    }
    .await;
    finish(result, "update the filing line")
}

async fn review(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
) -> Response {
    let result = async {
        let entity_id = entity_or_400(&caller).await?;
        let unresolved = filings::review_filing(&caller.db, &entity_id, &id).await?;
        let detail = filings::load_filing_detail(&caller.db, &entity_id, &id).await?;
        audit(
            &caller,
            Some(&entity_id),
            "form_1099_filing",
            &id,
            "reviewed",
            None,
        )
        .await;
        caller.publish(
            &state,
            FORM_1099_FILING_UPDATED,
            &id,
            event_data(&detail, &[]),
        );
        Ok(ok(with(detail, &[("unresolved", json!(unresolved))])))
    }
    .await;
    finish(result, "review the 1099 filing")
}

async fn generate(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
) -> Response {
    let result = async {
        let entity_id = entity_or_400(&caller).await?;
        let count =
            filings::generate_filing(&caller.db, &caller.keyring(&state), &entity_id, &id).await?;
        let detail = filings::load_filing_detail(&caller.db, &entity_id, &id).await?;
        audit(
            &caller,
            Some(&entity_id),
            "form_1099_filing",
            &id,
            "generated",
            None,
        )
        .await;
        caller.publish(
            &state,
            FORM_1099_FILING_GENERATED,
            &id,
            event_data(&detail, &[("lineCount", json!(count))]),
        );
        Ok(ok(detail))
    }
    .await;
    finish(result, "generate the 1099 filing")
}

async fn iris_csv(
    caller: &Caller,
    state: &BooksState,
    id: &str,
    template: Option<Value>,
) -> Response {
    let result = async {
        let entity_id = entity_or_400(caller).await?;
        let headers = outputs::parse_template_headers(template.as_ref());
        let result = outputs::build_iris_files(
            &caller.db,
            &caller.keyring(state),
            &entity_id,
            id,
            &caller.user_id,
            headers,
        )
        .await?;
        let records: u64 = result["files"].as_array().map_or(0, |files| {
            files.iter().filter_map(|f| f["recordCount"].as_u64()).sum()
        });
        audit(
            caller,
            Some(&entity_id),
            "form_1099_filing",
            id,
            "iris_file_created",
            Some(changes(&[("records", Value::Null, json!(records))])),
        )
        .await;
        Ok(no_store(ok(result)))
    }
    .await;
    finish(result, "create the IRIS file")
}

async fn iris_get(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
) -> Response {
    let template = caller.query().get("templateHeaders").map(|t| json!(t));
    iris_csv(&caller, &state, &id, template).await
}

/// `irisBodySchema`: `templateHeaders` an array of strings or a string.
fn iris_body_ok(body: &Value) -> bool {
    let Some(map) = body.as_object() else {
        return false;
    };
    match map.get("templateHeaders") {
        None => true,
        Some(Value::Array(items)) => {
            items.len() <= 300
                && items
                    .iter()
                    .all(|h| h.as_str().is_some_and(|s| s.encode_utf16().count() <= 200))
        }
        Some(Value::String(text)) => text.encode_utf16().count() <= 60_000,
        Some(_) => false,
    }
}

async fn iris_post(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    let parsed: Value = serde_json::from_slice(&body).unwrap_or_else(|_| json!({}));
    if !iris_body_ok(&parsed) {
        return ApiError::bad_request("Invalid request body")
            .with_details(json!({ "formErrors": [], "fieldErrors": { "templateHeaders": ["Invalid input"] } }))
            .into_response();
    }
    let template = parsed
        .get("templateHeaders")
        .cloned()
        .or_else(|| caller.query().get("templateHeaders").map(|t| json!(t)));
    iris_csv(&caller, &state, &id, template).await
}

async fn copies(
    caller: Caller,
    State(state): State<BooksState>,
    Path((id, line_id)): Path<(String, String)>,
) -> Response {
    let result = async {
        let entity_id = entity_or_400(&caller).await?;
        let copies = outputs::parse_copies(caller.query().get("copies"))?;
        let result = outputs::build_copies(
            &caller.db,
            &caller.keyring(&state),
            caller.can("tax_ids:reveal"),
            &entity_id,
            &id,
            &line_id,
            copies,
            &caller.user_id,
        )
        .await?;
        Ok(no_store(ok(result)))
    }
    .await;
    finish(result, "build the form copies")
}

fn is_date_only(text: &str) -> bool {
    let b = text.as_bytes();
    b.len() == 10
        && b.iter().enumerate().all(|(i, c)| {
            if i == 4 || i == 7 {
                *c == b'-'
            } else {
                c.is_ascii_digit()
            }
        })
}

fn read_mark_filed(issues: &mut Issues, body: &Map<String, Value>) -> (String, Option<String>) {
    let number = issues.text_with(
        body,
        "confirmationNumber",
        Presence::Required,
        Text::trimmed(Some(1), Some(255)),
    );
    let filed_at = match body.get("filedAt") {
        None => None,
        Some(Value::String(text)) => {
            let datetime = weldsuite_kit::validation::Format::DatetimeOffset;
            let valid = weldsuite_kit::validation::js_date_iso(text).is_some()
                && (is_date_only(text) || {
                    let mut probe = Issues::default();
                    let map: Map<String, Value> =
                        [("v".to_owned(), json!(text))].into_iter().collect();
                    probe.text_with(
                        &map,
                        "v",
                        Presence::Required,
                        Text {
                            format: Some(datetime),
                            ..Text::default()
                        },
                    );
                    probe.is_empty()
                });
            if valid {
                weldsuite_kit::validation::js_date_iso(text)
            } else {
                let path = issues.path_of("filedAt");
                issues.push_raw(json!({ "code": "invalid_string", "validation": "datetime", "message": "Invalid datetime", "path": path }));
                None
            }
        }
        Some(other) => {
            let path = issues.path_of("filedAt");
            issues.push_raw(weldsuite_kit::validation::string_or_number_issue(
                &path,
                Some(other),
            ));
            None
        }
    };
    (number.into_option().unwrap_or_default(), filed_at)
}

async fn mark_filed(
    caller: Caller,
    State(state): State<BooksState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let (number, filed_at) = match validate(&headers, &body, read_mark_filed) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond("Failed to mark the 1099 filing as filed"),
    };
    let result = async {
        let entity_id = entity_or_400(&caller).await?;
        filings::mark_filed(&caller.db, &entity_id, &id, &number, filed_at).await?;
        let detail = filings::load_filing_detail(&caller.db, &entity_id, &id).await?;
        audit(
            &caller,
            Some(&entity_id),
            "form_1099_filing",
            &id,
            "filed",
            Some(changes(&[(
                "confirmationNumber",
                Value::Null,
                json!(number),
            )])),
        )
        .await;
        caller.publish(
            &state,
            FORM_1099_FILING_FILED,
            &id,
            event_data(&detail, &[("confirmationNumber", json!(number))]),
        );
        Ok(ok(detail))
    }
    .await;
    finish(result, "mark the 1099 filing as filed")
}

fn read_correct(
    issues: &mut Issues,
    body: &Map<String, Value>,
) -> (Vec<(String, f64)>, String, bool) {
    let boxes = read_boxes(issues, body, Presence::Required);
    let reason = issues.text_with(
        body,
        "reason",
        Presence::Required,
        Text::trimmed(Some(1), Some(255)),
    );
    let refresh = issues.boolean(body, "refreshRecipient", Presence::Optional);
    (
        boxes.unwrap_or_default(),
        reason.into_option().unwrap_or_default(),
        refresh.into_option().unwrap_or(false),
    )
}

async fn correct(
    caller: Caller,
    State(state): State<BooksState>,
    Path((id, line_id)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let (boxes, reason, refresh_recipient) = match validate(&headers, &body, read_correct) {
        Ok(data) => data,
        Err(refusal) => return refusal.respond("Failed to correct the filing line"),
    };
    let result = async {
        let entity_id = entity_or_400(&caller).await?;
        let new_line = filings::correct_line(
            &caller.db,
            &caller.keyring(&state),
            &entity_id,
            &id,
            &line_id,
            &boxes,
            &reason,
            refresh_recipient,
            &caller.user_id,
        )
        .await?;
        let detail = filings::load_filing_detail(&caller.db, &entity_id, &id).await?;
        audit(
            &caller,
            Some(&entity_id),
            "form_1099_filing",
            &id,
            "line_corrected",
            Some(changes(&[(&line_id, Value::Null, json!(new_line))])),
        )
        .await;
        caller.publish(
            &state,
            FORM_1099_FILING_UPDATED,
            &id,
            event_data(&detail, &[("corrected", json!(true))]),
        );
        Ok(created(with(
            detail,
            &[("correctionLineId", json!(new_line))],
        )))
    }
    .await;
    finish(result, "correct the filing line")
}

fn read_delivered(issues: &mut Issues, body: &Map<String, Value>) -> String {
    issues
        .choice(body, "method", Presence::Required, &["print", "email"])
        .into_option()
        .unwrap_or_default()
}

async fn delivered(
    caller: Caller,
    State(state): State<BooksState>,
    Path((id, line_id)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let method = match validate(&headers, &body, read_delivered) {
        Ok(method) => method,
        Err(refusal) => return refusal.respond("Failed to record the delivery"),
    };
    let result = async {
        let entity_id = entity_or_400(&caller).await?;
        let result =
            filings::mark_line_delivered(&caller.db, &entity_id, &id, &line_id, &method).await?;
        let detail = filings::load_filing_detail(&caller.db, &entity_id, &id).await?;
        audit(
            &caller,
            Some(&entity_id),
            "form_1099_filing",
            &id,
            "line_delivered",
            Some(changes(&[(&line_id, Value::Null, json!(method))])),
        )
        .await;
        caller.publish(
            &state,
            FORM_1099_FILING_UPDATED,
            &id,
            event_data(&detail, &[("delivered", json!(line_id))]),
        );
        let mut out = result;
        if let (Value::Object(target), Value::Object(source)) = (&mut out, detail) {
            target.extend(source);
        }
        Ok(ok(out))
    }
    .await;
    finish(result, "record the delivery")
}
